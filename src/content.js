// Fills Sleeper's empty NBA Team and Matchup tabs (sleeper.com/leagues/<id>/team
// and /matchup) with rosters, schedules, projections, lineup swaps and Lock-In.
// Falls back to a floating panel when the page has no placeholder to fill.
(() => {
  const { createApi, view, model, scoring, ui } = globalThis.SNP;
  const ROUTE = /^\/leagues\/(\d+)\/(team|matchup)\/?$/;
  const PLAYERS_PATH = '/v1/players/nba';
  const PLAYERS_KEY = 'players:nba:v4';
  const PLAYERS_TTL_MS = 12 * 3600e3;
  // Sleeper only allows trading picks this many seasons ahead; it isn't exposed per league.
  const PICK_SEASONS = 3;
  const FLOAT_AFTER_MS = 4000;
  const NOTICE_MS = 3000;
  const CLOCK_MS = 60e3;

  let active = null;

  // Sleeper is a single-page app, so route changes don't reload content scripts.
  // Polling also re-attaches the panel if React re-renders the tab.
  function sync() {
    const [, leagueId = null, page = null] = location.pathname.match(ROUTE) ?? [];
    if (leagueId !== (active?.leagueId ?? null)) {
      active?.destroy();
      active = leagueId ? mount(leagueId, page) : null;
    }
    active?.show(page);
    active?.attach();
  }

  function mount(leagueId, page) {
    const host = document.createElement('div');
    host.id = 'sleeper-nba-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL('src/panel.css')}"><div class="root"></div>`;
    const root = shadow.querySelector('.root');
    const mountedAt = Date.now();
    let hidden = null; // Sleeper's placeholder, hidden while we fill its spot

    const state = {
      leagueId,
      page, // 'team' | 'matchup', from the URL
      tab: 'page', // 'page' | 'api'
      now: Date.now(),
      error: null,
      league: null,
      usersById: null,
      rosters: null,
      players: null,
      rosterId: null,
      picks: null,
      week: null,
      currentWeek: null,
      minWeek: 1,
      maxWeek: Infinity,
      weeks: {},
      today: new Date().toLocaleDateString('en-CA'),
      openCalls: new Set(),
      me: null, // logged-in user id, when the page has a session
      swap: null, // lineup spot picked to swap, e.g. 's:2' or 'b:<player id>'
      saving: false,
      notice: null, // { kind: 'error' | 'ok', text }
      lockConfirm: null, // player id whose Lock-In is awaiting confirmation
    };
    let destroyed = false;
    let disabled = false;
    let frame = 0;
    const api = createApi(schedule);

    function attach() {
      if (destroyed || disabled) return;
      const placeholder = document.querySelector('.postdraft-panel .empty-panel-container');
      const panel = placeholder?.closest('.postdraft-panel');
      if (panel) {
        const wrapper = [...panel.children].find((c) => c.contains(placeholder));
        if (hidden !== wrapper) {
          restorePlaceholder();
          hidden = wrapper;
          hidden.style.display = 'none';
        }
        if (host.parentElement !== panel || host.previousElementSibling !== wrapper) {
          host.classList.remove('floating');
          wrapper.after(host);
        }
      } else if (!host.isConnected && Date.now() - mountedAt > FLOAT_AFTER_MS) {
        host.classList.add('floating');
        document.documentElement.appendChild(host);
      }
    }

    function restorePlaceholder() {
      if (hidden) hidden.style.display = '';
      hidden = null;
    }

    function schedule() {
      if (frame || destroyed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (destroyed) return;
        const scrollTop = root.querySelector('.body')?.scrollTop ?? 0;
        state.now = Date.now();
        root.innerHTML = view.render(state, api.log);
        const body = root.querySelector('.body');
        if (body) body.scrollTop = scrollTop;
      });
    }

    function fail(err) {
      if (destroyed) return;
      console.error('[sleeper-nba-panel]', err);
      state.error = String(err.message || err);
      schedule();
    }

    async function loadPlayers(force) {
      if (!force) {
        const { [PLAYERS_KEY]: hit } = await chrome.storage.local.get(PLAYERS_KEY);
        if (hit && Date.now() - hit.savedAt < PLAYERS_TTL_MS) {
          api.cached(PLAYERS_PATH, hit.players, JSON.stringify(hit.players).length);
          return hit.players;
        }
      }
      const raw = await api.get(PLAYERS_PATH);
      const players = {};
      for (const [id, p] of Object.entries(raw)) {
        players[id] = {
          name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
          first: p.first_name,
          last: p.last_name,
          team: p.team,
          position: p.position,
          positions: p.fantasy_positions || [],
          injury: p.injury_status,
          years_exp: p.years_exp,
        };
      }
      await chrome.storage.local.set({ [PLAYERS_KEY]: { savedAt: Date.now(), players } });
      return players;
    }

    async function loadLeague(force = false) {
      state.error = null;
      const league = await api.get(`/v1/league/${leagueId}`);
      if (league.sport !== 'nba') {
        console.info('[sleeper-nba-panel] not an NBA league, staying hidden');
        disabled = true;
        teardown();
        return;
      }
      const rosterKey = `roster:${leagueId}`;
      const [nbaState, users, rosters, bracket, traded, drafts, players, prefs, me] = await Promise.all([
        api.get('/v1/state/nba'),
        api.get(`/v1/league/${leagueId}/users`),
        loadRosters(),
        api.get(`/v1/league/${leagueId}/winners_bracket`),
        api.get(`/v1/league/${leagueId}/traded_picks`),
        api.get(`/v1/league/${leagueId}/drafts`),
        loadPlayers(force),
        chrome.storage.local.get(rosterKey),
        loadMe(),
      ]);
      const savedRoster = rosters.find((r) => r.roster_id === prefs[rosterKey]);
      const myRoster = me && rosters.find((r) => r.owner_id === me || (r.co_owners || []).includes(me));
      Object.assign(state, {
        league,
        usersById: Object.fromEntries(users.map((u) => [u.user_id, u])),
        rosters,
        players,
        me,
        rosterId: (savedRoster || myRoster || rosters[0])?.roster_id ?? null,
        minWeek: league.settings?.start_week || 1,
        maxWeek: lastWeek(league, bracket || []),
        pickContext: { traded: traded || [], seasons: pickSeasons(league, drafts || []) },
        weeks: {},
      });
      updatePicks();
      const current = Number(nbaState.display_week || nbaState.week || state.minWeek);
      state.currentWeek = Math.min(Math.max(current, state.minWeek), state.maxWeek);
      state.seasonType = nbaState.season_type;
      if (state.week == null) state.week = state.currentWeek;
      await loadWeek(state.week);
    }

    // Rosters straight from Sleeper when logged in. The public REST endpoint is
    // cached at the CDN for up to ~10 minutes, so it can lag a save the user just made.
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
          console.warn('[sleeper-nba-panel] league_rosters unavailable, using the public endpoint', err);
        }
      }
      return api.get(`/v1/league/${leagueId}/rosters`);
    }

    // Who is logged in, if anyone. Only used to decide which roster can be edited.
    async function loadMe() {
      if (!api.loggedIn()) return null;
      try {
        const data = await api.graphql('me', 'query me { me { user_id } }', { auth: true });
        return data?.me?.user_id ?? null;
      } catch (err) {
        console.warn('[sleeper-nba-panel] could not identify the logged-in user', err);
        return null;
      }
    }

    function updatePicks() {
      const { league, rosters, rosterId, pickContext } = state;
      state.picks = model.ownedPicks({
        rosterId,
        rosterIds: rosters.map((r) => r.roster_id),
        seasons: pickContext.seasons,
        rounds: league.settings?.draft_rounds || 0,
        traded: pickContext.traded,
      });
    }

    async function loadWeek(week) {
      schedule();
      if (state.weeks[week]) return;
      const { league } = state;
      const season = league.season;
      const seasonType = league.season_type || 'regular';
      const scoresQuery = `query scores {
  scores(sport: "nba", season_type: ${JSON.stringify(seasonType)}, season: ${JSON.stringify(season)}, week: ${Number(week)}) {
    date game_id metadata season season_type sport status start_time week
  }
}`;
      const standingsQuery = `query roster_standings {
  roster_standings(league_id: ${JSON.stringify(leagueId)}, round: ${Number(week)}) { roster_id rank }
}`;
      const [matchups, projections, stats, scores, research, legs, standings] = await Promise.all([
        api.get(`/v1/league/${leagueId}/matchups/${week}`),
        api.get(`/projections/nba/${season}/${week}?season_type=${seasonType}`),
        api.get(`/stats/nba/${season}/${week}?season_type=${seasonType}`),
        api.graphql(`scores (week ${week})`, scoresQuery),
        api.get(`/players/nba/research/${seasonType}/${season}/${week}?league_type=${league.settings?.type ?? 0}`),
        loadLegs(week),
        api.graphql(`roster_standings (week ${week})`, standingsQuery)
          .then((data) => data?.roster_standings ?? [])
          .catch(() => []),
      ]);
      const games = scores?.scores || [];
      const scoringSettings = league.scoring_settings || {};
      state.weeks[week] = {
        matchups: matchups || [],
        days: model.weekDays(games),
        gamesByTeam: model.gamesByTeam(games),
        games: games.map((g) => ({ start: g.start_time, status: g.status })),
        proj: model.pointsByGame(projections || [], scoringSettings, scoring.scoreStats),
        actual: model.pointsByGame(stats || [], scoringSettings, scoring.scoreStats),
        research: research || {},
        legs,
        ranks: model.standingsRanks(state.rosters, standings),
      };
      schedule();
    }

    // Lineups, Lock-In picks (starters_games) and server projections for a week.
    // Needs the logged-in session; null when logged out or refused.
    async function loadLegs(week) {
      if (!api.loggedIn()) return null;
      const query = `query matchup_legs {
  matchup_legs(league_id: ${JSON.stringify(leagueId)}, round: ${Number(week)}) {
    leg matchup_id roster_id round starters points proj_points max_points custom_points starters_games subs
  }
}`;
      try {
        const data = await api.graphql(`matchup_legs (week ${week})`, query, { auth: true });
        return data?.matchup_legs ?? null;
      } catch (err) {
        console.warn('[sleeper-nba-panel] matchup_legs unavailable', err);
        return null;
      }
    }

    // Writes the week's matchup leg, as Sleeper's apps do in season. Lock-In
    // picks travel as a JSON-encoded player -> game map; omit them to leave
    // existing locks untouched.
    async function saveLeg(label, rosterId, starters, startersGames) {
      const { week } = state;
      const variables = startersGames ? { starters_games: JSON.stringify(startersGames) } : {};
      await api.graphql(`${label} (week ${week})`, `mutation update_matchup_leg($starters_games: Map) {
  update_matchup_leg(league_id: ${JSON.stringify(leagueId)}, roster_id: ${Number(rosterId)}, leg: ${Number(week)}, round: ${Number(week)}, starters: ${JSON.stringify(starters)}, starters_games: $starters_games) {
    leg roster_id round starters starters_games
  }
}`, { auth: true, variables });
      state.weeks[week].legs = await loadLegs(week);
    }

    // Saves a lineup the way Sleeper's web app does: during the season starters
    // live on the week's matchup leg; outside it, on the roster itself.
    async function saveStarters(starters) {
      const { league, rosterId } = state;
      const list = JSON.stringify(starters);
      if (league.status === 'in_season') {
        await saveLeg('update_matchup_leg', rosterId, starters);
      } else {
        const data = await api.graphql('roster_update_starters', `mutation roster_update_starters {
  roster_update_starters(league_id: ${JSON.stringify(leagueId)}, roster_id: ${Number(rosterId)}, starters: ${list}) {
    roster_id starters players reserve taxi
  }
}`, { auth: true });
        const roster = state.rosters.find((r) => r.roster_id === rosterId);
        Object.assign(roster, data.roster_update_starters);
      }
    }

    // Runs one save at a time and reports how it went.
    async function save(work, okText, failText) {
      state.saving = true;
      state.notice = null;
      schedule();
      try {
        await work();
        const notice = { kind: 'ok', text: okText };
        state.notice = notice;
        setTimeout(() => {
          if (state.notice !== notice) return;
          state.notice = null;
          schedule();
        }, NOTICE_MS);
      } catch (err) {
        console.error('[sleeper-nba-panel] save failed', err);
        state.notice = { kind: 'error', text: `${failText}: ${err.message || err}` };
      } finally {
        state.saving = false;
        schedule();
      }
    }

    async function saveTaxi(rosterId, taxi) {
      const data = await api.graphql('roster_update_taxi', `mutation roster_update_taxi {
  roster_update_taxi(league_id: ${JSON.stringify(leagueId)}, roster_id: ${Number(rosterId)}, taxi: ${JSON.stringify(taxi)}) {
    roster_id starters players reserve taxi
  }
}`, { auth: true });
      Object.assign(state.rosters.find((r) => r.roster_id === rosterId), data.roster_update_taxi);
    }

    // Moves players between two spots. Taxi saves first, like Sleeper's web app,
    // so a starter displaced by a taxi player lands on an up-to-date roster.
    function swap(fromRef, toRef) {
      const lineup = ui.lineup(state);
      const next = model.applyMove(fromRef, toRef, lineup);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const taxiChanged = !same(next.taxi, lineup.taxi);
      const startersChanged = !same(next.starters, lineup.starters);
      const moved = model.describeMove(lineup, next)
        .map(({ id, to }) => `${ui.shortName(state.players[id] || { name: `Player #${id}` })} to ${to}`)
        .join(', ');
      state.swap = null;
      return save(async () => {
        if (taxiChanged) await saveTaxi(lineup.roster.roster_id, next.taxi);
        if (startersChanged) await saveStarters(next.starters);
      }, `Saved: ${moved}`, `Couldn't move ${moved}`);
    }

    // Locks a starter's most recent finished game. Final, so it's confirmed first.
    // `ref` is '<roster id>:<player id>', since either side of a matchup can be yours.
    function lockIn(ref) {
      const [rosterId, playerId] = [Number(ref.split(':')[0]), ref.split(':')[1]];
      const lineup = ui.lineup(state, rosterId);
      const player = state.players[playerId];
      state.lockConfirm = null;
      if (!lineup?.lockable || !lineup.starters.includes(playerId)) return;
      const days = model.playerDays(lineup.week, player?.team, playerId);
      const st = model.lockState(days, lineup.locks[playerId], Date.now());
      if (!st.lockable) {
        state.notice = { kind: 'error', text: 'That game can no longer be locked' };
        return schedule();
      }
      const locks = { ...lineup.locks, [playerId]: st.current.game.id };
      const name = player?.name || `Player #${playerId}`;
      return save(
        () => saveLeg('lock_in', rosterId, lineup.starters, locks),
        `Locked ${name}: ${(st.current.actual ?? 0).toFixed(2)}`,
        `Couldn't lock ${name}`,
      );
    }

    function pickSpot(ref) {
      if (state.saving) return;
      const lineup = ui.lineup(state);
      if (!lineup.editable) return;
      if (state.swap && state.swap !== ref && model.swapTargets(state.swap, lineup).includes(ref)) {
        swap(state.swap, ref);
        return;
      }
      state.swap = state.swap === ref ? null : ref;
      state.notice = null;
      schedule();
    }

    function setWeek(week) {
      state.week = week;
      state.swap = null;
      state.lockConfirm = null;
      state.notice = null;
      loadWeek(week).catch(fail);
    }

    root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        state.tab = tab.dataset.tab;
        return schedule();
      }
      const spot = e.target.closest('[data-spot]');
      if (spot) return pickSpot(spot.dataset.spot);
      const lock = e.target.closest('[data-lock]');
      if (lock && !state.saving) {
        state.lockConfirm = lock.dataset.lock;
        state.notice = null;
        return schedule();
      }
      const confirm = e.target.closest('[data-lock-confirm]');
      if (confirm && !state.saving) return lockIn(confirm.dataset.lockConfirm);
      if (e.target.closest('[data-lock-cancel]')) {
        state.lockConfirm = null;
        return schedule();
      }
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'prev' && state.week > state.minWeek) setWeek(state.week - 1);
      if (action === 'next' && state.week < state.maxWeek) setWeek(state.week + 1);
      if (action === 'refresh') loadLeague(true).catch(fail);
    });
    root.addEventListener('change', (e) => {
      if (e.target.dataset.action !== 'roster') return;
      state.rosterId = Number(e.target.value);
      state.swap = null;
      state.lockConfirm = null;
      state.notice = null;
      chrome.storage.local.set({ [`roster:${leagueId}`]: state.rosterId });
      updatePicks();
      schedule();
    });
    // <details> toggle doesn't bubble, so listen in the capture phase.
    root.addEventListener('toggle', (e) => {
      const id = Number(e.target.dataset?.call);
      // Rendering a <details open> fires toggle too; only re-render on a real change.
      if (!id || e.target.open === state.openCalls.has(id)) return;
      if (e.target.open) state.openCalls.add(id);
      else state.openCalls.delete(id);
      schedule();
    }, true);
    // Hide headshots the CDN doesn't have. Image errors don't bubble either.
    root.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('missing');
    }, true);

    function onKey(e) {
      if (e.key === 'Escape' && (state.swap || state.lockConfirm)) {
        state.swap = null;
        state.lockConfirm = null;
        schedule();
      }
    }
    document.addEventListener('keydown', onKey);
    // Lock windows and game states move with the clock.
    const clock = setInterval(schedule, CLOCK_MS);

    // Same league, other tab (Team <-> Matchup): keep the data, swap the view.
    function show(next) {
      if (!next || next === state.page) return;
      state.page = next;
      state.swap = null;
      state.lockConfirm = null;
      state.notice = null;
      schedule();
    }

    function teardown() {
      clearInterval(clock);
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
      host.remove();
      restorePlaceholder();
    }

    function destroy() {
      destroyed = true;
      teardown();
    }

    loadLeague().catch(fail);
    return { leagueId, attach, show, destroy };
  }

  // The season ends when the league's playoff bracket does. Round count comes
  // from the bracket itself; playoff_round_type sets weeks per round
  // (0: one week each, 1: two-week final, 2: two weeks each).
  function lastWeek(league, bracket) {
    const { playoff_week_start: start, playoff_round_type: roundType } = league.settings || {};
    const rounds = Math.max(0, ...bracket.map((m) => m.r));
    // Without a bracket there's nothing to bound by, so don't invent a limit.
    if (!start || !rounds) return Infinity;
    const weeks = roundType === 2 ? rounds * 2 : roundType === 1 ? rounds + 1 : rounds;
    return start + weeks - 1;
  }

  // Future picks start this season if its draft hasn't happened yet, else next season.
  function pickSeasons(league, drafts) {
    const season = Number(league.season);
    const done = drafts.some((d) => d.season === league.season && d.status === 'complete');
    const first = done ? season + 1 : season;
    return Array.from({ length: PICK_SEASONS }, (_, i) => String(first + i));
  }

  addEventListener('popstate', sync);
  setInterval(sync, 500);
  sync();
})();
