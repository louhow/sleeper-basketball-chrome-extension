// Runs in the page's own world. For NBA leagues, Sleeper's web app renders the
// waiver (W) and ADD buttons but answers clicks with "not yet available", and
// opens its own NBA player card from the Players and Trend tabs. This takes
// over those clicks once the extension has confirmed the league is NBA. The
// player id (and Sleeper's own waiver status) come from React props, which
// only this world can read, and go to the extension as JSON in a DOM event.
// It also keeps the Matchup tab when switching to an NBA league from the sidebar,
// adds shot-volume columns (and the admin adminFPTS and adminDelta) to the Players tab, and for NFL leagues reads (and
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

  // NBA Players tab, in Stats: shot-volume columns (FGM and FGA after PTS, 3PA
  // after 3PM, FTM and FTA at the end), which Sleeper's stats already carry but
  // don't score, so they show dimmed; and with a week picked, an Avg / Best /
  // Worst switch in the table's corner that swaps each player's week average
  // for their best or worst game. With admin tools on, adminFPTS and adminDelta
  // columns beside Sleeper's FPTS.
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
  // Volume columns by the column they follow; the rest go at the end.
  const VOLUME_AFTER = { pts: ['fgm', 'fga'], tpm: ['tpa'] };
  const VOLUME = ['fgm', 'fga', 'tpa', 'ftm', 'fta'];
  const PICKS = [['avg', 'Avg', 'Average per game this week'], ['best', 'Best', 'Best game this week'], ['worst', 'Worst', 'Worst game this week']];
  let weekPick = 'avg';
  const pickedGames = {}; // `${season}|${week}|${mode}` -> { [player id]: that game's stats }
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

  // Each player's best or worst game of a week, from the extension (which
  // answers before dispatchEvent returns). Null while the week loads; the
  // extension sends 'snp:week-games-ready' once it has.
  function weekGames(season, week, mode) {
    const key = `${season}|${week}|${mode}`;
    if (pickedGames[key]) return pickedGames[key];
    let games = null;
    const take = (e) => {
      games = JSON.parse(e.detail);
    };
    document.addEventListener('snp:week-games', take);
    send('snp:week-games-request', { season, week, mode });
    document.removeEventListener('snp:week-games', take);
    if (games) pickedGames[key] = games;
    return games;
  }
  document.addEventListener('snp:week-games-ready', () => patchPlayers());

  function playersPanel() {
    const league = document.documentElement.dataset.snpNbaLeague;
    const el = document.querySelector(PLAYERS_PANEL);
    const panel = el && fiber(el, (x) => x.scoringSettings && x.sport === 'nba' && 'leagueId' in x)?.stateNode;
    const ours = Boolean(panel?.state && admin && league && admin.leagueId === league && String(panel.props.leagueId) === league);
    return ours ? panel : null;
  }

  // Sleeper's columns with ours worked in: the admin pair right after FPTS (when on),
  // the volume columns (in Stats) after the stat they go with. Switching to
  // Projection, or admin tools off (?snp-admin=0), takes them back out. Null
  // until Sleeper has settled which FPTS it shows.
  function columns(keys, base, other, adminOn, volumeOn) {
    if (keys[0] !== base || keys.includes(other)) return null;
    const theirs = keys.filter((k) => k !== ADMIN_KEY && k !== DELTA_KEY && !VOLUME.includes(k));
    const out = volumeOn ? theirs.flatMap((k) => [k, ...(VOLUME_AFTER[k] || [])]) : theirs;
    if (volumeOn) out.push(...VOLUME.filter((k) => !out.includes(k)));
    if (adminOn) out.splice(1, 0, ADMIN_KEY, DELTA_KEY);
    return out;
  }

  // The players the list shows right now (after Sleeper's position, search and owned filters).
  function playersInView() {
    const grid = document.querySelector(`${PLAYERS_PANEL} .ReactVirtualized__Grid`);
    const list = grid && fiber(grid, (x) => Array.isArray(x.players) && x.playerStatsMap)?.memoizedProps;
    return (list?.players || []).map((p) => String(p.player_id));
  }

  // The stats map Sleeper renders is rebuilt from its own: the picked games
  // (Best or Worst) first, then adminFPTS = FPTS plus what the changed settings
  // add or take away, so it matches FPTS exactly until a value changes.
  function patchPlayers() {
    const panel = playersPanel();
    const adminOn = Boolean(panel && admin.enabled);
    document.documentElement.toggleAttribute('data-snp-admin-changed', Boolean(adminOn && admin.changed));
    document.documentElement.toggleAttribute('data-snp-admin-col', Boolean(panel?.state.statKeys?.includes(ADMIN_KEY)));
    sizeColumns(panel);
    if (!panel) {
      weekSwitch(null);
      return;
    }
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
    const { playerStatsMap: map, statKeys = [], statType, statInterval, season } = panel.state;
    const base = statType === 'stat' ? 'fpts' : 'fpts_proj';
    const other = base === 'fpts' ? 'fpts_proj' : 'fpts';
    // A week picked in Stats (rather than the season).
    const week = statType === 'stat' && statInterval != null && statInterval !== 'season' ? Number(statInterval) : null;
    weekSwitch(week);
    const mode = week ? weekPick : 'avg';
    const picked = mode === 'avg' ? null : weekGames(season, week, mode);
    // Sleeper's own map: any map that isn't the one we last set.
    if (map && map !== panel.snpMap) panel.snpSource = map;
    const source = panel.snpSource;
    const view = adminOn ? playersInView() : [];
    // Order doesn't matter (sorting by adminDelta reorders it), only who is in view.
    const key = [mode, picked ? season : '', picked ? week : '', adminOn ? adminVersion : 'off', [...view].sort().join(',')].join('|');
    const update = {};
    if (source && (panel.snpSourceSeen !== source || panel.snpKey !== key)) {
      // That game alone, as one game played, so Sleeper's per-game numbers are its own.
      let stats = picked ? Object.fromEntries(Object.entries(source).map(([id, s]) =>
        [id, picked[id] ? { ...picked[id], fpts_proj: s?.fpts_proj } : s])) : source;
      if (adminOn) {
        const scores = admin.changed ? adminScores(stats, view, base) : { points: {}, shifts: {}, tints: {}, places: {} };
        const inView = new Set(view);
        // New objects per player, so Sleeper's rows see the change and re-render.
        stats = Object.fromEntries(Object.entries(stats).map(([id, s]) => {
          if (s?.[base] == null) return [id, s];
          // Per game, so it sorts by the number on screen: Sleeper shows every stat
          // per game (a season's stats are totals) but sorts on the stored value.
          const games = s.gp > 0 ? s.gp : 1;
          const out = { ...s, [ADMIN_KEY]: (s[base] + (scores.points[id] ?? 0)) / games };
          if (inView.has(id)) out[DELTA_KEY] = DELTA_OFFSET + (scores.shifts[id] ?? 0);
          return [id, out];
        }));
        tints = scores.tints;
        places = scores.places;
      }
      if (stats !== map) update.playerStatsMap = stats;
      panel.snpSourceSeen = source;
      panel.snpKey = key;
    }
    const keys = columns(statKeys, base, other, adminOn, statType === 'stat');
    if (keys && keys.join() !== statKeys.join()) update.statKeys = keys;
    if (Object.keys(update).length) {
      if (update.playerStatsMap) panel.snpMap = update.playerStatsMap;
      panel.setState(update);
    }
    watchRows();
    decorateRows();
  }

  // The Avg / Best / Worst switch, in the empty corner of the table's header
  // above the player names, while a week is picked in Stats.
  function weekSwitch(week) {
    const header = document.querySelector(`${PLAYERS_PANEL} .table-header`);
    let el = document.querySelector(`${PLAYERS_PANEL} .snp-week-pick`);
    if (!week || !header) {
      el?.remove();
      return;
    }
    if (!el || el.parentElement !== header) {
      el?.remove();
      el = document.createElement('div');
      el.className = 'snp-week-pick';
      el.setAttribute('role', 'radiogroup');
      el.setAttribute('aria-label', 'Week stats');
      el.innerHTML = PICKS.map(([mode, label, title]) =>
        `<button type="button" role="radio" data-snp-pick="${mode}" title="${title}">${label}</button>`).join('');
      el.addEventListener('click', (e) => {
        const button = e.target.closest('[data-snp-pick]');
        e.stopPropagation();
        if (!button || button.dataset.snpPick === weekPick) return;
        weekPick = button.dataset.snpPick;
        patchPlayers();
      });
      header.append(el);
    }
    for (const button of el.children) {
      const on = button.dataset.snpPick === weekPick;
      if (button.getAttribute('aria-checked') !== String(on)) button.setAttribute('aria-checked', String(on));
    }
  }

  // A span of ours over a cell whose own text (Sleeper's, hidden) can't say what we mean.
  function overlay(cell, cls) {
    if (!cell.hasAttribute('data-snp-cell')) cell.setAttribute('data-snp-cell', '');
    let el = cell.querySelector(`:scope > .${cls}`);
    if (!el) {
      el = document.createElement('span');
      el.className = cls;
      cell.append(el);
    }
    return el;
  }

  // Sleeper divides every stored stat by games played and prints one decimal.
  // adminFPTS is stored per game already (to sort right), so its number is
  // drawn over the cell; adminDelta shows as a badge: "+3" in green, "−2" in
  // red, deeper the further the player moves, with both places under it
  // ("#13→#42"). The sorted column's header gets a thin bar under it.
  // Rows mount as the list scrolls, so they're watched.
  function decorateRows() {
    const panel = playersPanel();
    const keys = panel?.state.statKeys || [];
    const k = keys.indexOf(DELTA_KEY);
    if (k < 0) return;
    const labels = document.querySelectorAll(`${PLAYERS_PANEL} .stat-key-header > .label`);
    labels.forEach((label, i) => {
      const sorted = keys[i] === panel.state.sort;
      if (label.hasAttribute('data-snp-sorted') !== sorted) label.toggleAttribute('data-snp-sorted', sorted);
    });
    const kAdmin = keys.indexOf(ADMIN_KEY);
    const map = panel.state.playerStatsMap || {};
    for (const row of document.querySelectorAll(`${PLAYERS_PANEL} .player-list-item`)) {
      const cells = row.querySelectorAll(':scope > .cell');
      const cell = cells[k];
      const id = fiber(row, (x) => x.player?.player_id)?.memoizedProps.player.player_id;
      if (!cell || id == null) continue;
      const perGame = map[id]?.[ADMIN_KEY];
      const value = overlay(cells[kAdmin], 'snp-admin-value');
      const shown = perGame == null ? '-' : perGame.toFixed(1);
      if (value.textContent !== shown) value.textContent = shown;
      const stored = map[id]?.[DELTA_KEY];
      const shift = stored == null ? null : stored - DELTA_OFFSET;
      const text = shift == null ? '-' : shift > 0 ? `+${shift}` : shift < 0 ? `−${-shift}` : '0';
      if (!cell.hasAttribute('data-snp-delta')) cell.setAttribute('data-snp-delta', '');
      const badge = overlay(cell, 'snp-delta');
      if (badge.textContent !== text) badge.textContent = text;
      const [was, now] = places[id] || [];
      const where = was && admin.changed ? `#${was}→#${now}` : '';
      const line = overlay(cell, 'snp-places');
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

  // Sleeper's rows are 796px (overflow hidden), with 60px stat columns that
  // start 161px in, after the name area; that fits its 9 columns. With more,
  // the name area would shrink and pull every value left of its header, and the
  // last columns would be cut off. So the columns narrow to share the 635px
  // (each has a 2px margin), and the name area keeps the 118px Sleeper's own
  // rows have, which centers each value under its (left-aligned) header as
  // Sleeper's table does. The volume columns are dimmed: they don't score.
  const ROW_ROOM = 635;
  const volumeStyle = document.createElement('style');
  function sizeColumns(panel) {
    const keys = panel?.state.statKeys || [];
    const html = document.documentElement;
    const width = keys.length > 9 ? `${Math.min(60, Math.floor(ROW_ROOM / keys.length) - 2)}px` : '';
    if (html.style.getPropertyValue('--snp-col') !== width) {
      if (width) html.style.setProperty('--snp-col', width);
      else html.style.removeProperty('--snp-col');
    }
    html.toggleAttribute('data-snp-cols', Boolean(width));
    const nth = keys.flatMap((k, i) => (VOLUME.includes(k) ? [i + 1] : []));
    const css = nth.length ? `${PLAYERS_PANEL} :is(${nth.map((n) => `.stat-key-header > :nth-child(${n} of .label), .player-list-item > :nth-child(${n} of .cell)`).join(', ')}) { opacity: 0.5; }` : '';
    if (volumeStyle.textContent !== css) volumeStyle.textContent = css;
  }

  // The admin headers read as named (not uppercase), on two lines.
  // adminFPTS wears the what-if color once a value differs from the league's.
  const ours = ':is(:nth-child(2 of .label), :nth-child(3 of .label))';
  const adminStyle = document.createElement('style');
  adminStyle.textContent = `
    html[data-snp-cols] ${PLAYERS_PANEL} :is(.stat-key-header > .label, .player-list-item > .cell) { flex-basis: var(--snp-col) !important; }
    html[data-snp-cols] ${PLAYERS_PANEL} .player-list-item > .player-meta-container { flex: 0 0 118px !important; }
    html[data-snp-admin-col] ${PLAYERS_PANEL} .stat-key-header > ${ours} span {
      text-transform: none; font-size: 10px; line-height: 10px; white-space: normal; width: min-content;
    }
    html[data-snp-admin-changed] ${PLAYERS_PANEL} .stat-key-header > ${ours} span,
    html[data-snp-admin-changed] ${PLAYERS_PANEL} .player-list-item > :nth-child(2 of .cell) { color: #b69cff !important; }
    ${PLAYERS_PANEL} [data-snp-cell] { font-size: 0 !important; }
    ${PLAYERS_PANEL} .snp-admin-value { font-size: 12px; }
    ${PLAYERS_PANEL} [data-snp-delta] { flex-direction: column; gap: 2px; }
    ${PLAYERS_PANEL} .stat-key-header > .label { position: relative; }
    ${PLAYERS_PANEL} .stat-key-header > .label[data-snp-sorted]::after {
      content: ''; position: absolute; left: 0; width: 24px; bottom: 0; height: 2px; border-radius: 1px; background: #00ceb8;
    }
    ${PLAYERS_PANEL} .snp-places { font-size: 9px; line-height: 10px; color: rgba(255, 255, 255, 0.55); white-space: nowrap; font-variant-numeric: tabular-nums; }
    ${PLAYERS_PANEL} .snp-places:empty { display: none; }
    ${PLAYERS_PANEL} .table-header:has(> .snp-week-pick) { position: relative; }
    ${PLAYERS_PANEL} .snp-week-pick {
      position: absolute; left: 16px; top: 15px; display: flex; padding: 2px; border-radius: 13px; background: rgb(32, 38, 53);
    }
    ${PLAYERS_PANEL} .snp-week-pick button {
      height: 22px; padding: 0 8px; border: 0; border-radius: 11px; background: none; cursor: pointer;
      font: 700 12px Poppins, sans-serif; color: rgb(185, 196, 212);
    }
    ${PLAYERS_PANEL} .snp-week-pick button:hover { color: #fff; }
    ${PLAYERS_PANEL} .snp-week-pick button[aria-checked="true"] { background: rgb(196, 213, 230); color: rgb(2, 32, 71); }
    ${PLAYERS_PANEL} .snp-delta {
      min-width: 28px; padding: 2px 6px; border-radius: 4px; box-sizing: border-box;
      font-size: 12px; font-weight: 700; text-align: center; color: rgba(255, 255, 255, 0.45); font-variant-numeric: tabular-nums;
    }`;
  (document.head || document.documentElement).append(adminStyle, volumeStyle);

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
