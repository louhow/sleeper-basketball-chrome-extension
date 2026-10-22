// Fills Sleeper's empty web page for Premier League fantasy leagues
// (sleeper.com/leagues/<id>, which only says "not supported on web yet") with
// the mobile app's Match, Team, Players and League tabs. One session per
// league, rendered into a shadow root in place of Sleeper's placeholder, with
// dialogs in a separate page-level host.
(() => {
  const { createApi, view, model, scoring, ui, dialogs, card } = globalThis.SEP;
  const SPORT = 'clubsoccer:epl';
  const ROUTE = /^\/leagues\/(\d+)(?:\/([^/]+))?/;
  const PAGE_BY_ROUTE = { team: 'team', matchup: 'match', players: 'players', league: 'league', standings: 'league', transactions: 'league' };
  const PLAYERS_PATH = `/v1/players/${SPORT}`;
  const PLAYERS_KEY = 'players:epl:v1';
  const PLAYERS_TTL_MS = 12 * 3600e3;
  const FLOAT_AFTER_MS = 4000;
  const NOTICE_MS = 3500;
  const CLOCK_MS = 60e3;
  const CAREER_SEASONS = 5;
  const TRANSACTION_FIELDS = 'adds drops leg roster_ids settings status status_updated transaction_id type created creator metadata';
  const LEG_FIELDS = [
    'leg matchup_id roster_id round starters points proj_points max_points custom_points players_points',
    'leg matchup_id roster_id round starters points proj_points custom_points',
    'leg matchup_id roster_id round starters points',
  ];
  // Sleeper's placeholder for sports its website doesn't run yet.
  const PLACEHOLDER_TEXT = /not supported on web/i;

  // The stylesheet is inlined into each shadow root, so nothing ever paints unstyled.
  const stylesheet = fetch(chrome.runtime.getURL('src/panel.css')).then((r) => r.text());
  const storage = chrome.storage?.local;

  let active = null;

  // Sleeper is a single-page app, so route changes don't reload content scripts.
  function routePath() {
    return document.documentElement.dataset.sepRoute || location.pathname;
  }
  function sync() {
    const [, leagueId = null, page = null] = routePath().match(ROUTE) ?? [];
    if (leagueId !== (active?.leagueId ?? null)) {
      active?.destroy();
      active = leagueId ? mount(leagueId, page) : null;
    }
    active?.show(page);
    active?.attach();
  }

  function mount(leagueId, routePage) {
    const host = document.createElement('div');
    host.id = 'sleeper-epl-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style></style><div class="root"></div>';
    const root = shadow.querySelector('.root');
    const layer = document.createElement('div');
    layer.id = 'sleeper-epl-dialog';
    const layerShadow = layer.attachShadow({ mode: 'open' });
    layerShadow.innerHTML = '<style></style><div class="root"></div>';
    const layerRoot = layerShadow.querySelector('.root');
    let styled = false;
    stylesheet.then((css) => {
      shadow.querySelector('style').textContent = css;
      layerShadow.querySelector('style').textContent = css;
      styled = true;
      schedule();
    });
    let mountedAt = Date.now();
    let hidden = null; // Sleeper's placeholder, hidden while we fill its spot

    const state = {
      leagueId,
      page: PAGE_BY_ROUTE[routePage] || 'match',
      tab: 'page',
      now: Date.now(),
      today: new Date().toLocaleDateString('en-CA'),
      error: null,
      league: null,
      usersById: null,
      rosters: null,
      players: null,
      pool: null,
      teams: {},
      teamAbbr: (id) => state.teams[id]?.abbr || id,
      me: null,
      loggedIn: false,
      myRosterId: null,
      rosterId: null,
      week: null,
      currentWeek: null,
      minWeek: 1,
      maxWeek: 38,
      weeks: {},
      openCalls: new Set(),
      swap: null,
      saving: false,
      notice: null,
      ready: false,
      claims: null,
      trending: null,
      season: null,
      cards: {},
      modal: null,
      playersTab: { mode: 'available', position: 'ALL', query: '', trend: 'add', shown: 0, freeAgentsOnly: false },
      waiverStatus: (id) => waiverStatus(id),
    };
    let destroyed = false;
    let disabled = false;
    let frame = 0;
    let seasonLoading = false;
    const api = createApi(schedule);

    // Mounts the panel in place of Sleeper's placeholder, or floats it when there's none.
    function attach() {
      if (destroyed || disabled) return;
      const placeholder = findPlaceholder();
      if (placeholder) {
        const parent = placeholder.parentElement;
        if (hidden !== placeholder) {
          restorePlaceholder();
          hidden = placeholder;
          hidden.style.display = 'none';
        }
        if (host.parentElement !== parent || host.previousElementSibling !== placeholder) {
          host.classList.remove('floating');
          placeholder.after(host);
        }
        parent.style.minHeight ||= '0';
      } else if (!host.isConnected && Date.now() - mountedAt > FLOAT_AFTER_MS) {
        host.classList.add('floating');
        document.documentElement.appendChild(host);
      }
    }

    // Sleeper's "not supported on web yet" block: by class when it has the one
    // its NBA tabs use, else the block of text that says so.
    function findPlaceholder() {
      const byClass = document.querySelector('.empty-panel-container');
      if (byClass) return byClass;
      const scope = document.querySelector('main, .main-content, #__next, body');
      if (!scope) return null;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (PLACEHOLDER_TEXT.test(node.data) && !host.contains(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      const text = walker.nextNode();
      if (!text) return null;
      // Climb to the block that holds the illustration, the text and the store
      // badges: keep going while the parent still holds little else (by text),
      // so the league header and chat beside it are never swallowed.
      // The placeholder is a small centered block inside a tall panel, so the
      // climb also stops once the block already fills its parent.
      let el = text.parentElement;
      for (let i = 0; i < 6; i++) {
        const parent = el.parentElement;
        if (!parent || parent === scope || parent === document.body) break;
        if ((parent.textContent || '').trim().length > 400 || parent.querySelector('h1, h2, h3, nav, input')) break;
        const own = el.getBoundingClientRect();
        const outer = parent.getBoundingClientRect();
        if (outer.height > 0 && own.height >= 0.7 * outer.height && own.width >= 0.7 * outer.width) break;
        el = parent;
      }
      return el;
    }

    function restorePlaceholder() {
      if (hidden) hidden.style.display = '';
      hidden = null;
    }

    function schedule() {
      if (frame || destroyed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (destroyed || !styled) return;
        state.now = Date.now();
        renderLayer();
        if (!(state.ready || state.error)) {
          root.innerHTML = '<div class="app"><p class="msg">Loading Premier League league…</p></div>';
          return;
        }
        const body = root.querySelector('.body');
        const scrollTop = body?.scrollTop ?? 0;
        const focused = shadow.activeElement?.matches?.('[data-search]');
        const caret = focused ? shadow.activeElement.selectionStart : null;
        root.innerHTML = view.render(state, api.log);
        const next = root.querySelector('.body');
        if (next) next.scrollTop = scrollTop;
        if (focused) {
          const input = root.querySelector('[data-search]');
          input?.focus();
          if (input && caret != null) input.setSelectionRange(caret, caret);
        }
      });
    }

    function renderLayer() {
      const showNotice = Boolean(state.notice) && state.modal;
      if (!state.modal && !showNotice) return layer.remove();
      if (!layer.isConnected) document.documentElement.appendChild(layer);
      const scrolls = [...layerRoot.querySelectorAll('.dialog-body')].map((el) => [el.dataset.scroll || 'dialog', el.scrollTop]);
      const focused = layerShadow.activeElement?.matches?.('[data-bid]');
      const kind = state.modal?.kind;
      const html = kind === 'player' ? card.render(state) : dialogs.render(state);
      layerRoot.innerHTML = `<div class="page-layer">${html}${showNotice ? ui.notice(state) : ''}</div>`;
      for (const [key, top] of scrolls) {
        const el = layerRoot.querySelector(key === 'dialog' ? '.dialog-body' : `[data-scroll="${key}"]`);
        if (el) el.scrollTop = top;
      }
      const input = layerRoot.querySelector('[data-bid]');
      if (input && (focused || state.modal?.focus)) {
        input.focus();
        state.modal.focus = false;
      }
    }

    function fail(err) {
      if (destroyed) return;
      console.error('[sleeper-epl]', err);
      state.error = String(err.message || err);
      schedule();
    }

    async function loadPlayers(force) {
      if (!force && storage) {
        const { [PLAYERS_KEY]: hit } = await storage.get(PLAYERS_KEY);
        if (hit && Date.now() - hit.savedAt < PLAYERS_TTL_MS) {
          api.cached(PLAYERS_PATH, hit.players, JSON.stringify(hit.players).length);
          return hit.players;
        }
      }
      const raw = await api.get(PLAYERS_PATH);
      const players = {};
      for (const [id, p] of Object.entries(raw)) {
        const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
        players[id] = {
          name,
          first: p.first_name,
          last: p.last_name,
          team: p.team,
          teamAbbr: p.team_abbr,
          position: p.position,
          positions: p.fantasy_positions || (p.position ? [p.position] : []),
          injury: p.injury_status,
          injuryReturn: p.metadata?.soccer_injury_return_date || null,
          years_exp: p.years_exp,
          number: p.number,
          age: p.age,
          height: p.height,
          weight: p.weight,
          rank: p.search_rank,
          active: p.active !== false && p.status !== 'RET',
          competitions: p.competitions || null,
          search: `${p.search_full_name || ''} ${name.toLowerCase()} ${(p.team_abbr || '').toLowerCase()}`,
        };
      }
      if (storage) await storage.set({ [PLAYERS_KEY]: { savedAt: Date.now(), players } });
      return players;
    }

    async function loadLeague(force = false) {
      state.error = null;
      state.loggedIn = api.loggedIn();
      const league = await api.get(`/v1/league/${leagueId}`);
      if (league.sport !== SPORT) {
        disabled = true;
        teardown();
        console.info(`[sleeper-epl] ${league.sport} league, staying hidden`);
        return;
      }
      const rosterKey = `roster:${leagueId}`;
      const [sportState, users, rosters, scheduleRows, players, prefs, me] = await Promise.all([
        api.get(`/v1/state/${SPORT}`),
        api.get(`/v1/league/${leagueId}/users`),
        loadRosters(),
        api.get(`/schedule/${SPORT}/${league.season_type || 'regular'}/${league.season}`).catch(() => []),
        loadPlayers(force),
        storage ? storage.get([rosterKey]) : {},
        loadMe(),
      ]);
      for (const p of Object.values(players)) if (p.team && p.teamAbbr) state.teams[p.team] ||= { abbr: p.teamAbbr };
      for (const g of scheduleRows || []) {
        for (const side of [g.home, g.away]) if (side?.team) state.teams[side.team] = { abbr: side.abbr, name: side.name };
      }
      const savedRoster = rosters.find((r) => r.roster_id === prefs?.[rosterKey]);
      const myRoster = me && rosters.find((r) => r.owner_id === me || (r.co_owners || []).includes(me));
      Object.assign(state, {
        league,
        usersById: Object.fromEntries(users.map((u) => [u.user_id, u])),
        rosters,
        players,
        pool: null,
        me,
        myRosterId: myRoster?.roster_id ?? null,
        rosterId: (myRoster || savedRoster || rosters[0])?.roster_id ?? null,
        minWeek: league.settings?.start_week || 1,
        maxWeek: Math.max(league.settings?.playoff_week_start || 0, ...(scheduleRows || []).map((g) => g.week || 0)) || 38,
        schedule: scheduleRows || [],
        weeks: {},
        cards: {},
      });
      const current = Number(sportState.display_week || sportState.week || state.minWeek);
      state.currentWeek = Math.min(Math.max(current, state.minWeek), state.maxWeek);
      if (state.week == null) state.week = state.currentWeek;
      await loadWeek(state.week);
      state.ready = true;
      schedule();
      if (state.currentWeek !== state.week) loadWeek(state.currentWeek).catch(fail);
      if (state.currentWeek > state.minWeek) loadWeek(state.currentWeek - 1).catch(() => {});
      loadClaims();
      loadTrending();
      if (state.page === 'players') loadSeason();
    }

    async function loadRosters() {
      if (api.loggedIn()) {
        try {
          const data = await api.graphql('league_rosters', `query league_rosters {
  league_rosters(league_id: ${JSON.stringify(leagueId)}) {
    roster_id owner_id co_owners players starters reserve taxi settings metadata
  }
}`, { auth: true });
          if (data?.league_rosters?.length) return data.league_rosters;
        } catch (err) {
          console.warn('[sleeper-epl] league_rosters unavailable, using the public endpoint', err);
        }
      }
      return api.get(`/v1/league/${leagueId}/rosters`);
    }

    async function loadMe() {
      if (!api.loggedIn()) return null;
      try {
        const data = await api.graphql('me', 'query me { me { user_id } }', { auth: true });
        return data?.me?.user_id ?? null;
      } catch (err) {
        console.warn('[sleeper-epl] could not identify the logged-in user', err);
        return null;
      }
    }

    async function loadWeek(week) {
      schedule();
      if (state.weeks[week]) return;
      const { league } = state;
      const season = league.season;
      const seasonType = league.season_type || 'regular';
      const scoresQuery = `query scores {
  scores(sport: ${JSON.stringify(SPORT)}, season_type: ${JSON.stringify(seasonType)}, season: ${JSON.stringify(season)}, week: ${Number(week)}) {
    date game_id metadata season season_type sport status start_time week
  }
}`;
      const standingsQuery = `query roster_standings {
  roster_standings(league_id: ${JSON.stringify(leagueId)}, round: ${Number(week)}) { roster_id rank }
}`;
      const [projections, stats, scores, research, legs, transactions, standings] = await Promise.all([
        api.get(`/projections/${SPORT}/${season}/${week}?season_type=${seasonType}`).catch(() => []),
        api.get(`/stats/${SPORT}/${season}/${week}?season_type=${seasonType}`).catch(() => []),
        api.graphql(`scores (week ${week})`, scoresQuery).catch(() => null),
        api.get(`/players/${SPORT}/research/${seasonType}/${season}/${week}?league_type=${league.settings?.type ?? 0}`).catch(() => ({})),
        loadLegs(week),
        api.get(`/v1/league/${leagueId}/transactions/${week}`).catch(() => []),
        api.graphql(`roster_standings (week ${week})`, standingsQuery).then((d) => d?.roster_standings ?? []).catch(() => []),
      ]);
      let games = model.gamesFromScores(scores?.scores || []);
      if (!games.length) games = model.gamesFromScores((state.schedule || []).filter((g) => g.week === week));
      const settings = league.scoring_settings || {};
      state.weeks[week] = {
        week,
        games,
        gamesByTeam: model.gamesByTeam(games),
        projRows: projections || [],
        statRows: stats || [],
        proj: model.pointsByGame(projections || [], settings, scoring.scoreStats),
        actual: model.pointsByGame(stats || [], settings, scoring.scoreStats),
        research: research || {},
        legs,
        transactions: transactions || [],
        ranks: model.standingsRanks(state.rosters, standings),
        scoring: settings,
      };
      schedule();
    }

    // Lineups, matchup pairings and Sleeper's own points for a week. Needs the
    // logged-in session; null when logged out or refused.
    async function loadLegs(week) {
      if (!api.loggedIn()) return null;
      const queries = LEG_FIELDS.map((fields) => `query matchup_legs {
  matchup_legs(league_id: ${JSON.stringify(leagueId)}, round: ${Number(week)}) { ${fields} }
}`);
      try {
        const data = await api.graphqlAny(`matchup_legs (week ${week})`, queries, { auth: true });
        return data?.matchup_legs ?? null;
      } catch (err) {
        console.warn('[sleeper-epl] matchup_legs unavailable', err);
        return null;
      }
    }

    async function loadClaims() {
      const roster = ui.myRoster(state);
      if (!roster || !api.loggedIn()) return;
      try {
        const data = await api.graphql('league_transactions_filtered (pending waivers)', `query league_transactions_filtered {
  league_transactions_filtered(league_id: ${JSON.stringify(leagueId)}, roster_id_filters: [${Number(roster.roster_id)}], type_filters: ["waiver"], leg_filters: [], status_filters: ["pending"]) {
    ${TRANSACTION_FIELDS}
  }
}`, { auth: true });
        state.claims = data?.league_transactions_filtered ?? [];
      } catch (err) {
        console.warn('[sleeper-epl] pending waivers unavailable', err);
        state.claims ??= [];
      }
      schedule();
    }

    async function loadTrending() {
      const fetchTrend = (type) => api.get(`/v1/players/${SPORT}/trending/${type}?lookback_hours=24&limit=50`).catch(() => []);
      const [add, drop] = await Promise.all([fetchTrend('add'), fetchTrend('drop')]);
      state.trending = { add: add || [], drop: drop || [] };
      schedule();
    }

    // Season totals for every player (Leaders, FPTS column). Loaded once, on demand.
    async function loadSeason() {
      if (state.season || seasonLoading || !state.league) return;
      seasonLoading = true;
      try {
        const rows = await api.get(`/stats/${SPORT}/${state.league.season}?season_type=${state.league.season_type || 'regular'}`);
        state.season = { stats: Object.fromEntries((rows || []).map((r) => [r.player_id, r.stats || {}])) };
      } catch (err) {
        console.warn('[sleeper-epl] season stats unavailable', err);
        state.season = { stats: {} };
      } finally {
        seasonLoading = false;
        schedule();
      }
    }

    // Whether an unrostered player is likely on waivers right now.
    function waiverStatus(playerId) {
      const week = state.weeks[state.currentWeek];
      const transactions = [...(week?.transactions || []), ...(state.weeks[state.currentWeek - 1]?.transactions || [])];
      const games = week ? model.playerGames(week, state.players[playerId]?.team, playerId) : [];
      return model.waiverGuess({ league: state.league, playerId, transactions, games, now: state.now });
    }

    // Writes the week's matchup leg, as Sleeper's apps do in season.
    async function saveLeg(rosterId, starters) {
      const { week } = state;
      await api.graphql(`update_matchup_leg (week ${week})`, `mutation update_matchup_leg {
  update_matchup_leg(league_id: ${JSON.stringify(leagueId)}, roster_id: ${Number(rosterId)}, leg: ${Number(week)}, round: ${Number(week)}, starters: ${JSON.stringify(starters)}) {
    leg roster_id round starters
  }
}`, { auth: true });
      state.weeks[week].legs = await loadLegs(week);
    }

    async function saveStarters(starters) {
      const { league, rosterId } = state;
      if (league.status === 'in_season') {
        await saveLeg(rosterId, starters);
      } else {
        const data = await api.graphql('roster_update_starters', `mutation roster_update_starters {
  roster_update_starters(league_id: ${JSON.stringify(leagueId)}, roster_id: ${Number(rosterId)}, starters: ${JSON.stringify(starters)}) {
    roster_id starters players reserve taxi
  }
}`, { auth: true });
        Object.assign(state.rosters.find((r) => r.roster_id === rosterId), data.roster_update_starters);
      }
    }

    async function saveReserve(rosterId, reserve) {
      const data = await api.graphql('roster_update_reserve', `mutation roster_update_reserve {
  roster_update_reserve(league_id: ${JSON.stringify(leagueId)}, roster_id: ${Number(rosterId)}, reserve: ${JSON.stringify(reserve)}) {
    roster_id starters players reserve taxi
  }
}`, { auth: true });
      Object.assign(state.rosters.find((r) => r.roster_id === rosterId), data.roster_update_reserve);
    }

    async function save(work, okText, failText) {
      state.saving = true;
      state.notice = null;
      schedule();
      try {
        await work();
        flash(okText);
      } catch (err) {
        console.error('[sleeper-epl] save failed', err);
        state.notice = { kind: 'error', text: `${failText}: ${err.message || err}` };
      } finally {
        state.saving = false;
        schedule();
      }
    }

    function flash(text) {
      const notice = { kind: 'ok', text };
      state.notice = notice;
      setTimeout(() => {
        if (state.notice !== notice) return;
        state.notice = null;
        schedule();
      }, NOTICE_MS);
    }

    // Moves players between two spots. IR goes in three steps so no save ever
    // has a player both starting and on IR.
    function swap(fromRef, toRef) {
      const lineup = ui.lineup(state);
      const next = model.applyMove(fromRef, toRef, lineup);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const reserveChanged = !same(next.reserve, lineup.reserve);
      const toReserve = new Set(next.reserve.filter((id) => !lineup.reserve.includes(id)));
      const benched = lineup.starters.map((id) => (toReserve.has(id) ? '0' : id));
      const startersChanged = !same(next.starters, lineup.starters);
      const moved = model.describeMove(lineup, next)
        .map(({ id, to }) => `${ui.shortName(state.players[id] || { name: `Player #${id}` })} to ${to}`)
        .join(', ');
      state.swap = null;
      return save(async () => {
        if (reserveChanged && !same(benched, lineup.starters)) await saveStarters(benched);
        if (reserveChanged) await saveReserve(lineup.roster.roster_id, next.reserve);
        if (startersChanged && !(reserveChanged && same(benched, next.starters))) await saveStarters(next.starters);
      }, `Saved: ${moved}`, `Couldn't move ${moved}`);
    }

    function pickSpot(ref) {
      if (state.saving) return;
      const lineup = ui.lineup(state);
      if (!lineup?.editable) return;
      if (state.swap && state.swap !== ref && model.swapTargets(state.swap, lineup).includes(ref)) {
        swap(state.swap, ref);
        return;
      }
      state.swap = state.swap === ref ? null : ref;
      state.notice = null;
      schedule();
    }

    function openOptimize() {
      const lineup = ui.lineup(state);
      if (state.saving || !lineup?.editable || !lineup.week) return;
      state.swap = null;
      state.notice = null;
      state.modal = { kind: 'optimize', plan: model.bestLineup(lineup, Date.now()), errors: [], saving: false };
      schedule();
    }

    function applyOptimize() {
      const m = state.modal;
      const lineup = ui.lineup(state);
      if (m?.kind !== 'optimize' || m.saving || !lineup?.editable) return;
      const plan = model.bestLineup(lineup, Date.now());
      if (JSON.stringify(plan.starters) !== JSON.stringify(m.plan.starters)) {
        m.plan = plan;
        m.errors = ['Matches have kicked off since this opened. Review the updated changes.'];
        return schedule();
      }
      if (!plan.changes.length) return;
      const moved = plan.changes.length > 3 ? `${plan.changes.length} lineup changes` : plan.changes
        .map(({ id, to }) => `${ui.shortName(state.players[id] || { name: `Player #${id}` })} to ${to === 'BN' ? 'bench' : to.replace('_FLEX', ' flex')}`)
        .join(', ');
      return modalSave(() => saveStarters(plan.starters), `Saved: ${moved}`);
    }

    // Opens the add / waiver-bid dialog for an unrostered player.
    function openAdd(playerId) {
      const guess = waiverStatus(playerId);
      state.modal = { kind: 'add', playerId, status: guess, guess, bid: '', drops: [], errors: [], saving: false, focus: true };
      state.notice = null;
      schedule();
    }

    function openDrop(playerId) {
      state.modal = { kind: 'drop', playerId, errors: [], saving: false };
      state.notice = null;
      schedule();
    }

    function openClaims() {
      state.modal = { kind: 'claims', errors: [], saving: false };
      state.notice = null;
      schedule();
      loadClaims();
    }

    // Player card: each part loads on its own and renders as it arrives.
    function openCard(playerId, back = null) {
      if (!state.ready) return;
      state.modal = { kind: 'player', playerId, tab: 'summary', season: null, back };
      state.notice = null;
      schedule();
      if (state.cards[playerId]) return;
      const c = (state.cards[playerId] = { logs: {} });
      const player = state.players[playerId] || {};
      const current = Number(state.league.season);
      const back_ = Math.min(Math.max(Number(player.years_exp) || 0, 0), CAREER_SEASONS - 1);
      const years = Array.from({ length: back_ + 1 }, (_, i) => current - i);
      const id = encodeURIComponent(playerId);
      const type = state.league.season_type || 'regular';
      const part = (promise, apply, fallback) => promise
        .then(apply)
        .catch((err) => {
          console.warn('[sleeper-epl] player card', err);
          fallback?.();
        })
        .finally(schedule);
      part(api.get(`/players/${SPORT}/${id}`), (bio) => { c.bio = bio; });
      part(Promise.all(years.map((season) => api.get(`/stats/${SPORT}/player/${id}?season_type=${type}&season=${season}`)
        .then((row) => ({ season, team: row?.team, stats: row?.stats || null }))
        .catch(() => ({ season, stats: null })))), (rows) => {
        c.career = rows.filter((r) => r.season === current || r.stats?.gp);
        c.seasons = [current, ...c.career.filter((r) => r.season !== current).map((r) => r.season)];
      }, () => { c.career = []; c.seasons = [current]; });
      loadCardLog(playerId, current);
      part(api.graphql('get_player_news', `query get_player_news {
  get_player_news(sport: "clubsoccer", player_id: ${JSON.stringify(playerId)}, limit: 10) { metadata player_id published source source_key sport }
}`), (data) => { c.news = data?.get_player_news ?? []; }, () => { c.news = []; });
      if (api.loggedIn()) {
        part(api.graphql('league_transactions_by_player', `query league_transactions_by_player {
  league_transactions_by_player(league_id: ${JSON.stringify(leagueId)}, player_id: ${JSON.stringify(playerId)}) {
    ${TRANSACTION_FIELDS} draft_picks
  }
}`, { auth: true }), (data) => { c.history = data?.league_transactions_by_player ?? []; }, () => { c.historyError = true; });
      } else {
        c.historyError = true;
      }
    }

    function loadCardLog(playerId, season) {
      const c = state.cards[playerId];
      if (!c || c.logs[season] || c.pendingLogs?.has(season)) return;
      (c.pendingLogs ||= new Set()).add(season);
      const query = `?season_type=${state.league.season_type || 'regular'}&season=${Number(season)}&grouping=week`;
      const id = encodeURIComponent(playerId);
      Promise.all([api.get(`/stats/${SPORT}/player/${id}${query}`).catch(() => ({})), api.get(`/projections/${SPORT}/player/${id}${query}`).catch(() => ({}))])
        .then(([stats, proj]) => { c.logs[season] = { stats: stats || {}, proj: proj || {} }; })
        .finally(() => {
          c.pendingLogs.delete(season);
          schedule();
        });
    }

    function closeModal() {
      if (state.modal?.saving) return;
      state.modal = state.modal?.back ?? null;
      schedule();
    }

    async function modalSave(work, okText) {
      const m = state.modal;
      if (!m || m.saving) return;
      m.saving = true;
      m.errors = [];
      schedule();
      try {
        await work();
        if (state.modal === m) state.modal = m.kind === 'claims' ? { ...m, saving: false } : null;
        flash(okText);
      } catch (err) {
        console.error('[sleeper-epl] save failed', err);
        m.errors = [String(err.message || err)];
      } finally {
        m.saving = false;
        schedule();
      }
    }

    const name = (id) => state.players[id]?.name || `Player #${id}`;
    const LISTS = '$k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]';
    const ARGS = 'k_adds: $k_adds, v_adds: $v_adds, k_drops: $k_drops, v_drops: $v_drops';

    // Submits the add dialog: a waiver claim (with a FAAB bid) or a free-agent add, plus drops.
    function submitClaim() {
      const m = state.modal;
      const roster = ui.myRoster(state);
      if (m?.kind !== 'add' || m.saving || !roster || !state.ready) return;
      const waiver = m.status === 'waiver';
      const error = model.claimError({ league: state.league, roster, waiver, bid: m.bid, drops: m.drops });
      if (error) {
        m.errors = [error];
        return schedule();
      }
      const rid = Number(roster.roster_id);
      const variables = { k_adds: [m.playerId], v_adds: [rid], k_drops: m.drops, v_drops: m.drops.map(() => rid) };
      const bid = waiver && state.league.settings?.waiver_type === model.FAAB;
      if (bid) Object.assign(variables, { k_settings: ['waiver_bid'], v_settings: [Number(m.bid)] });
      const dropping = m.drops.length ? ` (dropping ${m.drops.map(name).join(', ')})` : '';
      const league = JSON.stringify(leagueId);
      return modalSave(async () => {
        if (waiver) {
          await api.graphql('submit_waiver_claim', `mutation submit_waiver_claim(${LISTS}${bid ? ', $k_settings: [String], $v_settings: [Int]' : ''}) {
  submit_waiver_claim(league_id: ${league}, ${ARGS}${bid ? ', k_settings: $k_settings, v_settings: $v_settings' : ''}) {
    ${TRANSACTION_FIELDS}
  }
}`, { auth: true, variables });
          await loadClaims();
        } else {
          await api.graphql('league_create_transaction', `mutation league_create_transaction(${LISTS}) {
  league_create_transaction(league_id: ${league}, type: "free_agent", ${ARGS}) {
    ${TRANSACTION_FIELDS}
  }
}`, { auth: true, variables });
          await refreshRosters();
        }
      }, waiver
        ? `${bid ? `$${Number(m.bid)} bid` : 'Claim'} placed for ${name(m.playerId)}${dropping}`
        : `Added ${name(m.playerId)}${dropping}`);
    }

    function confirmDrop() {
      const m = state.modal;
      const roster = ui.myRoster(state);
      if (m?.kind !== 'drop' || m.saving || !roster) return;
      const rid = Number(roster.roster_id);
      const variables = { k_adds: [], v_adds: [], k_drops: [m.playerId], v_drops: [rid] };
      return modalSave(async () => {
        await api.graphql('league_create_transaction (drop)', `mutation league_create_transaction(${LISTS}) {
  league_create_transaction(league_id: ${JSON.stringify(leagueId)}, type: "free_agent", ${ARGS}) {
    ${TRANSACTION_FIELDS}
  }
}`, { auth: true, variables });
        await refreshRosters();
      }, `Dropped ${name(m.playerId)}`);
    }

    // After an add or drop: rosters, the week's lineup and this week's transactions.
    async function refreshRosters() {
      state.rosters = await loadRosters();
      state.pool = null;
      const week = state.weeks[state.currentWeek];
      if (week) {
        const [legs, transactions] = await Promise.all([loadLegs(state.currentWeek), api.get(`/v1/league/${leagueId}/transactions/${state.currentWeek}`).catch(() => week.transactions)]);
        week.legs = legs ?? week.legs;
        week.transactions = transactions || week.transactions;
      }
    }

    const claimById = (id) => state.claims?.find((c) => c.transaction_id === id);

    function updateClaimBid(id, value) {
      const claim = claimById(id);
      const roster = ui.myRoster(state);
      if (!claim || !roster) return;
      const error = model.claimError({ league: state.league, roster: { ...roster, players: [] }, waiver: true, bid: value, drops: [] });
      if (error) {
        state.modal.errors = [error];
        return schedule();
      }
      const settings = { ...claim.settings, waiver_bid: Number(value) };
      const variables = { k_settings: Object.keys(settings), v_settings: Object.values(settings).map(Number) };
      const who = name(Object.keys(claim.adds || {})[0]);
      return modalSave(async () => {
        await api.graphql('update_waiver_claim', `mutation update_waiver_claim($k_settings: [String], $v_settings: [Int]) {
  update_waiver_claim(league_id: ${JSON.stringify(leagueId)}, transaction_id: ${JSON.stringify(id)}, leg: ${Number(claim.leg)}, k_settings: $k_settings, v_settings: $v_settings) {
    ${TRANSACTION_FIELDS}
  }
}`, { auth: true, variables });
        await loadClaims();
      }, `Bid for ${who} is now $${Number(value)}`);
    }

    function cancelClaim(id) {
      const claim = claimById(id);
      if (!claim) return;
      state.modal.confirmCancel = null;
      const who = name(Object.keys(claim.adds || {})[0]);
      return modalSave(async () => {
        await api.graphql('cancel_waiver_claim', `mutation cancel_waiver_claim {
  cancel_waiver_claim(league_id: ${JSON.stringify(leagueId)}, leg: ${Number(claim.leg)}, transaction_id: ${JSON.stringify(id)}) {
    ${TRANSACTION_FIELDS}
  }
}`, { auth: true });
        await loadClaims();
      }, `Canceled the claim for ${who}`);
    }

    function setWeek(week) {
      state.week = week;
      state.swap = null;
      state.notice = null;
      loadWeek(week).catch(fail);
    }

    function setPage(page) {
      state.page = page;
      state.tab = 'page';
      state.swap = null;
      state.notice = null;
      if (page === 'players') loadSeason();
      schedule();
    }

    root.addEventListener('click', (e) => {
      const page = e.target.closest('[data-page]');
      if (page) return setPage(page.dataset.page);
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        state.tab = tab.dataset.tab;
        return schedule();
      }
      const spot = e.target.closest('[data-spot]');
      if (spot) return pickSpot(spot.dataset.spot);
      const add = e.target.closest('[data-add]');
      if (add) return openAdd(add.dataset.add);
      const drop = e.target.closest('[data-drop-player]');
      if (drop) return openDrop(drop.dataset.dropPlayer);
      const player = e.target.closest('[data-player]');
      if (player) return openCard(player.dataset.player);
      const ptab = e.target.closest('[data-ptab]');
      if (ptab) {
        state.playersTab.mode = ptab.dataset.ptab;
        state.playersTab.shown = 0;
        if (['leaders', 'all'].includes(ptab.dataset.ptab)) loadSeason();
        return schedule();
      }
      const pos = e.target.closest('[data-pos]');
      if (pos) {
        state.playersTab.position = pos.dataset.pos;
        state.playersTab.shown = 0;
        return schedule();
      }
      const trend = e.target.closest('[data-trend]');
      if (trend) {
        state.playersTab.trend = trend.dataset.trend;
        return schedule();
      }
      if (e.target.closest('[data-more]')) {
        state.playersTab.shown = (state.playersTab.shown || globalThis.SEP.players.PAGE) + globalThis.SEP.players.PAGE;
        return schedule();
      }
      const rosterEl = e.target.closest('[data-roster]');
      if (rosterEl) {
        setRoster(Number(rosterEl.dataset.roster));
        return setPage('team');
      }
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'prev' && state.week > state.minWeek) setWeek(state.week - 1);
      if (action === 'next' && state.week < state.maxWeek) setWeek(state.week + 1);
      if (action === 'refresh') loadLeague(true).catch(fail);
      if (action === 'claims') openClaims();
      if (action === 'optimize') openOptimize();
    });
    function setRoster(id) {
      state.rosterId = id;
      state.swap = null;
      state.notice = null;
      storage?.set({ [`roster:${leagueId}`]: state.rosterId });
    }
    root.addEventListener('change', (e) => {
      if (e.target.dataset.action === 'roster') {
        setRoster(Number(e.target.value));
        return schedule();
      }
      if (e.target.matches('[data-fa-only]')) {
        state.playersTab.freeAgentsOnly = e.target.checked;
        state.playersTab.shown = 0;
        schedule();
      }
    });
    root.addEventListener('input', (e) => {
      if (!e.target.matches('[data-search]')) return;
      state.playersTab.query = e.target.value;
      state.playersTab.shown = 0;
      schedule();
    });
    root.addEventListener('toggle', (e) => {
      const id = Number(e.target.dataset?.call);
      if (!id || e.target.open === state.openCalls.has(id)) return;
      if (e.target.open) state.openCalls.add(id);
      else state.openCalls.delete(id);
      schedule();
    }, true);
    root.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('missing');
    }, true);

    layerRoot.addEventListener('click', (e) => {
      const m = state.modal;
      const drop = e.target.closest('[data-drop]');
      if (drop && m?.kind === 'add' && !m.saving) {
        const id = drop.dataset.drop;
        m.drops = m.drops.includes(id) ? m.drops.filter((d) => d !== id) : [...m.drops, id];
        m.errors = [];
        return schedule();
      }
      const mode = e.target.closest('[data-add-mode]');
      if (mode && m?.kind === 'add' && !m.saving) {
        m.status = mode.dataset.addMode;
        m.errors = [];
        return schedule();
      }
      const save_ = e.target.closest('[data-claim-save]');
      if (save_) {
        const id = save_.dataset.claimSave;
        const input = layerRoot.querySelector(`[data-claim-bid="${CSS.escape(id)}"]`);
        return updateClaimBid(id, input?.value ?? '');
      }
      const cancel = e.target.closest('[data-claim-cancel]');
      if (cancel && m?.kind === 'claims' && !m.saving) {
        m.confirmCancel = cancel.dataset.claimCancel;
        m.errors = [];
        return schedule();
      }
      if (e.target.closest('[data-claim-cancel-keep]') && m) {
        m.confirmCancel = null;
        return schedule();
      }
      const confirmed = e.target.closest('[data-claim-cancel-confirm]');
      if (confirmed) return cancelClaim(confirmed.dataset.claimCancelConfirm);
      const addBtn = e.target.closest('[data-add]');
      if (addBtn && !m?.saving) return openAdd(addBtn.dataset.add);
      const dropBtn = e.target.closest('[data-drop-player]');
      if (dropBtn && !m?.saving) return openDrop(dropBtn.dataset.dropPlayer);
      const cardTab = e.target.closest('[data-card-tab]');
      if (cardTab && m?.kind === 'player') {
        m.tab = cardTab.dataset.cardTab;
        if (m.tab === 'log') loadCardLog(m.playerId, m.season ?? state.cards[m.playerId]?.seasons?.[0] ?? Number(state.league.season));
        return schedule();
      }
      const season = e.target.closest('[data-card-season]');
      if (season && m?.kind === 'player') {
        m.season = Number(season.dataset.cardSeason);
        loadCardLog(m.playerId, m.season);
        return schedule();
      }
      const player = e.target.closest('[data-player]');
      if (player && !m?.saving && m?.kind !== 'player') return openCard(player.dataset.player, m);
      if (player && m?.kind === 'player' && player.dataset.player !== m.playerId) return openCard(player.dataset.player, m.back);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close-modal') closeModal();
      if (action === 'submit-claim') submitClaim();
      if (action === 'confirm-drop') confirmDrop();
      if (action === 'apply-lineup') applyOptimize();
    });
    layerRoot.addEventListener('input', (e) => {
      if (e.target.matches('[data-bid]') && state.modal) state.modal.bid = e.target.value;
    });
    layerRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-bid]')) submitClaim();
    });
    layerRoot.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('missing');
    }, true);

    function onKey(e) {
      if (e.key === 'Escape' && state.modal) return closeModal();
      if (e.key === 'Escape' && state.swap) {
        state.swap = null;
        schedule();
      }
    }
    document.addEventListener('keydown', onKey);
    const clock = setInterval(schedule, CLOCK_MS);

    // Same league, another Sleeper route: follow it when it names a tab.
    function show(routePage_) {
      const page = PAGE_BY_ROUTE[routePage_];
      if (page && page !== state.page) setPage(page);
    }

    function teardown() {
      clearInterval(clock);
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
      host.remove();
      layer.remove();
      restorePlaceholder();
    }

    function destroy() {
      destroyed = true;
      teardown();
    }

    loadLeague().catch(fail);
    return { leagueId, attach, show, destroy };
  }

  new MutationObserver(sync).observe(document, { childList: true, subtree: true });
  addEventListener('popstate', sync);
  setInterval(sync, 500);
  sync();
})();
