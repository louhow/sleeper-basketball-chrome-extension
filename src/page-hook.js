// Runs in the page's own world. For NBA leagues, Sleeper's web app renders the
// waiver (W) and ADD buttons but answers clicks with "not yet available", and
// opens its own NBA player card from the Players and Trend tabs. This takes
// over those clicks once the extension has confirmed the league is NBA. The
// player id (and Sleeper's own waiver status) come from React props, which
// only this world can read, and go to the extension as JSON in a DOM event.
// It also keeps the Matchup tab when switching to an NBA league from the sidebar,
// adds the adminFPTS and adminDelta columns to the Players tab, and for NFL leagues reads (and
// saves) the Team tab's lineup for Optimize lineup.
(() => {
  const ACTION = '.player-action-button.waiver, .player-action-button.add';
  // Player name and headshot on the Players tab, and a row on the Trend tab.
  const PLAYER = '.player-meta-container, .trending-list-item .player-details';
  // A league in the left sidebar.
  const NAV_LEAGUE = 'a.nav-league-item-wrapper';
  const MAX_DEPTH = 12;

  // The nearest fiber (walking up from the element) whose props pass `match`.
  function fiber(el, match) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    for (let f = key && el[key], i = 0; f && i < MAX_DEPTH; f = f.return, i++) {
      if (f.memoizedProps && match(f.memoizedProps)) return f;
    }
    return null;
  }

  const props = (el, match) => fiber(el, match)?.memoizedProps ?? null;

  function send(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
  }

  addEventListener('click', (e) => {
    const league = document.documentElement.dataset.snpNbaLeague;
    if (!league || !location.pathname.startsWith(`/leagues/${league}/`) || !(e.target instanceof Element)) return;
    const action = e.target.closest(ACTION);
    const card = !action && e.target.closest(PLAYER);
    const p = action ? props(action, (x) => x.playerId)
      : card ? props(card, (x) => x.playerId || x.player?.player_id)
      : null;
    if (!p) return;
    // Window capture runs before React's listener on the document, so Sleeper never sees the click.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (action) {
      const status = p.waiverStatus?.status || (action.classList.contains('waiver') ? 'waiver' : 'free_agent');
      send('snp:player-action', { playerId: String(p.playerId), status, clearTime: p.waiverStatus?.clearTime ?? null });
    } else {
      send('snp:player-card', { playerId: String(p.playerId || p.player.player_id) });
    }
  }, true);

  // Sleeper's sidebar sends every league to /leagues/<id>, which lands on its
  // League tab. From a Matchup tab, an NBA league opens on its Matchup tab
  // instead, through Sleeper's own router so its state stays in step.
  addEventListener('click', (e) => {
    if (!/^\/leagues\/\d+\/matchup(\/|$)/.test(location.pathname) || !(e.target instanceof Element)) return;
    const link = e.target.closest(NAV_LEAGUE);
    const item = link && props(link, (x) => x.league && x.selectLeague);
    const nav = item && props(link, (x) => x.router?.push);
    if (item?.league.sport !== 'nba' || !nav) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = item.league.league_id;
    item.selectLeague(id);
    item.closeNavbar?.();
    nav.router.push(`/leagues/${id}/matchup`);
  }, true);

  // NBA Players tab: adminFPTS and adminDelta columns beside Sleeper's FPTS.
  // adminFPTS is scored with the what-if values from the extension's Scoring
  // control; adminDelta is how many places that moves a player in the list on
  // screen. Both go into Sleeper's own table component (its stat keys and
  // per-player stats map), so Sleeper renders them and its headers sort them.
  // Sleeper prints a stat key as its header; the space lets each wrap onto two lines.
  const ADMIN_KEY = 'admin FPTS';
  const DELTA_KEY = 'admin Delta';
  // Sleeper sorts a missing or 0 value as -1, so shifts are stored offset to stay positive.
  const DELTA_OFFSET = 10000;
  const PLAYERS_PANEL = '.integration-players-panel';
  // { leagueId, enabled, changed } from the extension; it does the scoring itself.
  // Not enabled (no ?snp-admin=1), the columns stay out.
  let admin = null;
  let adminVersion = 0;
  let tints = {};
  let places = {}; // player id -> [FPTS place, adminFPTS place] in the list on screen

  document.addEventListener('snp:admin-scoring', (e) => {
    admin = JSON.parse(e.detail);
    adminVersion++;
    patchPlayers();
  });

  // From the extension, which answers before dispatchEvent returns: per player,
  // the points the changed settings add, and for the players in view, their rank shift and its color.
  function adminScores(stats, view, base) {
    let out = { points: {}, shifts: {}, tints: {}, places: {} };
    const take = (e) => {
      out = JSON.parse(e.detail);
    };
    document.addEventListener('snp:admin-scores', take);
    send('snp:admin-score-request', { stats, view, base });
    document.removeEventListener('snp:admin-scores', take);
    return out;
  }

  function playersPanel({ disabled = false } = {}) {
    const league = document.documentElement.dataset.snpNbaLeague;
    const el = document.querySelector(PLAYERS_PANEL);
    const panel = el && fiber(el, (x) => x.scoringSettings && x.sport === 'nba' && 'leagueId' in x)?.stateNode;
    const ours = Boolean(panel?.state && admin && league && admin.leagueId === league && String(panel.props.leagueId) === league);
    return ours && (disabled || admin.enabled) ? panel : null;
  }

  // Admin tools turned off (?snp-admin=0) while the columns are up: take them back out.
  function removeColumns() {
    const panel = playersPanel({ disabled: true });
    const keys = panel?.state.statKeys || [];
    if (keys.includes(ADMIN_KEY) || keys.includes(DELTA_KEY)) {
      panel.setState({ statKeys: keys.filter((k) => k !== ADMIN_KEY && k !== DELTA_KEY) });
    }
  }

  // The players the list shows right now (after Sleeper's position, search and owned filters).
  function playersInView() {
    const grid = document.querySelector(`${PLAYERS_PANEL} .ReactVirtualized__Grid`);
    const list = grid && fiber(grid, (x) => Array.isArray(x.players) && x.playerStatsMap)?.memoizedProps;
    return (list?.players || []).map((p) => String(p.player_id));
  }

  // adminFPTS = Sleeper's FPTS plus what the changed settings add or take away,
  // so it matches FPTS exactly until a value changes.
  function patchPlayers() {
    if (admin && !admin.enabled) removeColumns();
    const panel = playersPanel();
    document.documentElement.toggleAttribute('data-snp-admin-changed', Boolean(panel && admin.changed));
    document.documentElement.toggleAttribute('data-snp-admin-col', Boolean(panel?.state.statKeys?.includes(ADMIN_KEY)));
    if (!panel) return;
    if (!panel.snpHooked) {
      // Sleeper replaces its stats map on every week, season or Projection/Stats switch,
      // and filters the list on its own state; patch right after.
      const didUpdate = panel.componentDidUpdate;
      panel.componentDidUpdate = function (...args) {
        didUpdate?.apply(this, args);
        patchPlayers();
      };
      panel.snpHooked = true;
    }
    const { playerStatsMap: map, statKeys = [], statType } = panel.state;
    const base = statType === 'stat' ? 'fpts' : 'fpts_proj';
    const other = base === 'fpts' ? 'fpts_proj' : 'fpts';
    const view = playersInView();
    // Order doesn't matter (sorting by adminDelta reorders it), only who is in view.
    const viewKey = `${adminVersion}|${[...view].sort().join(',')}`;
    const update = {};
    if (map && (panel.snpMap !== map || panel.snpVersion !== adminVersion || panel.snpViewKey !== viewKey)) {
      const scores = admin.changed ? adminScores(map, view, base) : { points: {}, shifts: {}, tints: {}, places: {} };
      const inView = new Set(view);
      // New objects per player, so Sleeper's rows see the change and re-render.
      update.playerStatsMap = Object.fromEntries(Object.entries(map).map(([id, stats]) => {
        if (stats?.[base] == null) return [id, stats];
        const { [DELTA_KEY]: _, ...rest } = stats;
        const out = { ...rest, [ADMIN_KEY]: stats[base] + (scores.points[id] ?? 0) };
        if (inView.has(id)) out[DELTA_KEY] = DELTA_OFFSET + (scores.shifts[id] ?? 0);
        return [id, out];
      }));
      tints = scores.tints;
      places = scores.places;
      panel.snpVersion = adminVersion;
      panel.snpViewKey = viewKey;
    }
    // Right after FPTS, once Sleeper has settled which FPTS it shows.
    if (statKeys[0] === base && !statKeys.includes(other) && !statKeys.includes(ADMIN_KEY)) {
      update.statKeys = [base, ADMIN_KEY, DELTA_KEY, ...statKeys.slice(1)];
    }
    if (Object.keys(update).length) {
      if (update.playerStatsMap) panel.snpMap = update.playerStatsMap;
      panel.setState(update);
    }
    watchRows();
    decorateRows();
  }

  // Sleeper prints every stat per game with one decimal ("3.0"), so adminDelta
  // shows as a badge over its cell: "+3" in green, "−2" in red, deeper the
  // further the player moves, with both places under it ("#13→#42").
  // Rows mount as the list scrolls, so they're watched.
  function decorateRows() {
    const panel = playersPanel();
    const k = panel?.state.statKeys?.indexOf(DELTA_KEY) ?? -1;
    if (k < 0) return;
    const map = panel.state.playerStatsMap || {};
    for (const row of document.querySelectorAll(`${PLAYERS_PANEL} .player-list-item`)) {
      const cell = row.querySelectorAll(':scope > .cell')[k];
      const id = fiber(row, (x) => x.player?.player_id)?.memoizedProps.player.player_id;
      if (!cell || id == null) continue;
      const stored = map[id]?.[DELTA_KEY];
      const shift = stored == null ? null : stored - DELTA_OFFSET;
      const text = shift == null ? '-' : shift > 0 ? `+${shift}` : shift < 0 ? `−${-shift}` : '0';
      if (!cell.hasAttribute('data-snp-delta')) cell.setAttribute('data-snp-delta', '');
      let badge = cell.querySelector(':scope > .snp-delta');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'snp-delta';
        cell.append(badge);
      }
      if (badge.textContent !== text) badge.textContent = text;
      const [was, now] = places[id] || [];
      const where = was && admin.changed ? `#${was}→#${now}` : '';
      let line = cell.querySelector(':scope > .snp-places');
      if (!line) {
        line = document.createElement('span');
        line.className = 'snp-places';
        cell.append(line);
      }
      if (line.textContent !== where) {
        line.textContent = where;
        cell.title = where && `Rank by FPTS ${was}, by adminFPTS ${now}, among the players listed`;
      }
      // Compared with what was set, since the browser rewrites style values.
      const tint = (shift && tints[id]) || '';
      if (badge.dataset.tint !== tint) {
        badge.dataset.tint = tint;
        badge.style.background = tint;
        badge.style.color = shift ? '#fff' : '';
      }
    }
  }

  let watched = null;
  let decorateFrame = 0;
  const rowWatcher = new MutationObserver(() => {
    decorateFrame ||= requestAnimationFrame(() => {
      decorateFrame = 0;
      decorateRows();
    });
  });
  function watchRows() {
    const el = document.querySelector(PLAYERS_PANEL);
    if (el === watched) return;
    rowWatcher.disconnect();
    watched = el;
    if (el) rowWatcher.observe(el, { childList: true, subtree: true, characterData: true });
  }

  setInterval(() => {
    if (document.documentElement.dataset.snpNbaLeague && document.querySelector(PLAYERS_PANEL)) patchPlayers();
  }, 500);

  // Sleeper's rows are 796px with 60px stat columns after the name area, which
  // fits its 9 columns; with 11 the name area would shrink and pull every value
  // left of its header. So every column narrows to 54px, and the name area keeps
  // the 118px Sleeper's own rows have, which centers each value under its
  // (left-aligned) header as Sleeper's table does.
  // Our headers read as named (not uppercase), on two lines.
  // adminFPTS wears the what-if color once a value differs from the league's.
  const ours = ':is(:nth-child(2 of .label), :nth-child(3 of .label))';
  const adminStyle = document.createElement('style');
  adminStyle.textContent = `
    html[data-snp-admin-col] ${PLAYERS_PANEL} :is(.stat-key-header > .label, .player-list-item > .cell) { flex-basis: 54px !important; }
    html[data-snp-admin-col] ${PLAYERS_PANEL} .player-list-item > .player-meta-container { flex: 0 0 118px !important; }
    html[data-snp-admin-col] ${PLAYERS_PANEL} .stat-key-header > ${ours} span {
      text-transform: none; font-size: 10px; line-height: 11px; white-space: normal;
    }
    html[data-snp-admin-changed] ${PLAYERS_PANEL} .stat-key-header > ${ours} span,
    html[data-snp-admin-changed] ${PLAYERS_PANEL} .player-list-item > :nth-child(2 of .cell) { color: #b69cff !important; }
    ${PLAYERS_PANEL} [data-snp-delta] { font-size: 0 !important; flex-direction: column; gap: 2px; }
    ${PLAYERS_PANEL} .snp-places { font-size: 9px; line-height: 10px; color: rgba(255, 255, 255, 0.55); white-space: nowrap; font-variant-numeric: tabular-nums; }
    ${PLAYERS_PANEL} .snp-places:empty { display: none; }
    ${PLAYERS_PANEL} .snp-delta {
      min-width: 28px; padding: 2px 6px; border-radius: 4px; box-sizing: border-box;
      font-size: 12px; font-weight: 700; text-align: center; color: rgba(255, 255, 255, 0.45); font-variant-numeric: tabular-nums;
    }`;
  (document.head || document.documentElement).append(adminStyle);

  // NFL Team tab. Sleeper's own Team component holds the lineup as shown
  // (state.starters: slot + player), the roster, players, which teams have
  // kicked off, and the save actions its web app uses.
  const TEAM = '.team-roster';
  const teamFiber = () => {
    const el = document.querySelector(TEAM);
    return el && fiber(el, (x) => x.updateMatchupLeg && x.playersMap && x.league);
  };
  // Sleeper's _updateRoster saves to the roster before the season and to the week's matchup leg during it.
  const inSeason = (league) => !['pre_draft', 'drafting', 'complete'].includes(league.status);

  // The lineup as the extension needs it, or null when this isn't an NFL Team tab.
  // Without `full`, only whether it can be edited (checked on every page change, so kept cheap).
  function nflLineup(leagueId, full) {
    const f = teamFiber();
    const p = f?.memoizedProps;
    if (!p || p.sport !== 'nfl' || String(p.leagueId) !== leagueId) return null;
    const editable = Boolean((p.isTeamOwner || p.isTeamCoOwner) && !p.disableEdit);
    if (!full) return { editable };
    const shown = f.stateNode?.state?.starters || [];
    const roster = p.roster || {};
    const starters = shown.map((s) => s.playerId || '0');
    const away = new Set([...starters, ...(roster.reserve || []), ...(roster.taxi || [])]);
    const bench = (roster.players || []).filter((id) => !away.has(id));
    const players = {};
    const played = {};
    for (const id of [...starters, ...bench]) {
      const pl = p.playersMap[id];
      if (!pl) continue;
      players[id] = {
        name: pl.position === 'DEF' ? `${pl.first_name || ''} ${pl.last_name || ''}`.trim() || id : `${pl.first_name} ${pl.last_name}`,
        position: pl.position,
        positions: pl.fantasy_positions || [pl.position],
        team: pl.team,
        injury: pl.injury_status || null,
      };
      if (p.hasTeamPlayedMap?.[pl.team]) played[id] = true;
    }
    // Each roster row renders Sleeper's projection with the raw projected stats and league scoring.
    const projections = {};
    let scoring = null;
    for (const el of document.querySelectorAll(`${TEAM} .team-roster-item .projections`)) {
      const x = props(el, (y) => 'proj' in y && y.playerId);
      if (!x) continue;
      projections[x.playerId] = { stats: x.proj?.stats || {}, opponent: x.proj?.opponent ?? null };
      scoring ||= x.scoringSettings;
    }
    return {
      leagueId,
      rosterId: p.roster?.roster_id ?? p.rosterId,
      round: p.round,
      editable,
      slots: shown.map((s) => s.slotPosition),
      starters,
      bench,
      players,
      played,
      projections,
      scoring,
    };
  }

  // Answered synchronously, so the extension has the lineup as soon as dispatchEvent returns.
  document.addEventListener('snp:nfl-lineup-request', (e) => {
    const { leagueId, full } = JSON.parse(e.detail);
    send('snp:nfl-lineup', nflLineup(leagueId, full));
  });

  // Saves a lineup through Sleeper's own actions, so its screen updates as if you'd made the swaps.
  document.addEventListener('snp:nfl-lineup-save', async (e) => {
    const { leagueId, rosterId, round, starters } = JSON.parse(e.detail);
    try {
      const p = teamFiber()?.memoizedProps;
      const rid = p && (p.roster?.roster_id ?? p.rosterId);
      if (!p || String(p.leagueId) !== leagueId || rid !== rosterId || p.round !== round) {
        throw new Error('The Team tab changed; open Optimize again');
      }
      const res = inSeason(p.league)
        ? await p.updateMatchupLeg(leagueId, rid, round, round, starters)
        : await p.rosterUpdateStarters(leagueId, rid, starters);
      const error = res?.errors?.[0];
      if (error) throw new Error(typeof error === 'string' ? error : error.message || 'Sleeper refused the lineup');
      send('snp:nfl-lineup-saved', { ok: true });
    } catch (err) {
      send('snp:nfl-lineup-saved', { ok: false, error: String(err.message || err) });
    }
  });
})();
