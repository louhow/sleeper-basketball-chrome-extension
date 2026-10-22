// Loads the unpacked extension into headless Chromium. sleeper.com redirects logged-out
// visitors away from league pages, so the page document is a stand-in that mirrors the
// markup of Sleeper's empty NBA Team tab; API calls stay live.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const EXT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = fileURLToPath(new URL('../../test-results/', import.meta.url));
const LEAGUE = process.env.SLEEPER_LEAGUE_ID || '1374952493246611456';
const TEAM_URL = `https://sleeper.com/leagues/${LEAGUE}/team`;
const MATCHUP_URL = `https://sleeper.com/leagues/${LEAGUE}/matchup`;
const PLAYERS_URL = `https://sleeper.com/leagues/${LEAGUE}/players`;
const panel = (sel = '') => `#sleeper-nba-panel ${sel}`;
const dialog = (sel = '') => `#sleeper-nba-dialog ${sel}`;

// Same structure, classes and sizes as the logged-in page (inspected 2026-10-19).
const TEAM_TAB = `<!doctype html><title>Sleeper</title>
<style>
  body { margin: 0; background: rgb(16, 33, 49); font-family: Lato, Arial, sans-serif; color: #fff; }
  .center-panel { position: absolute; left: 264px; top: 100px; width: 800px; height: 698px; display: flex; flex-direction: column; overflow: hidden; background: rgba(58, 70, 91, .5); border-radius: 16px; }
  .league-panel { display: flex; flex-direction: column; height: 696px; overflow: hidden; }
  .league-panel-tabs-wrapper { height: 696px; }
  .postdraft-panel { display: flex; flex-direction: column; height: 696px; }
  .center-tab-selector { display: flex; gap: 16px; height: 40px; padding: 24px; }
  .center-tab-selector div { padding: 10px 16px; border-radius: 10px; background: #3a3f4b; color: #f6b26b; font-weight: 800; }
  .center-tab-selector .selected { background: #f6b26b; color: #1a2233; }
  .empty-panel-container { display: flex; flex-direction: column; align-items: center; height: 242px; }
  .footer { position: absolute; bottom: 0; left: 0; right: 0; height: 95px; text-align: center; }
</style>
<template id="app"><div class="center-panel"><div class="league-panel"><div class="league-panel-tabs-wrapper"><div class="postdraft-panel">
  <div class="center-tab-selector"><div>MATCHUP</div><div class="selected">TEAM</div><div>LEAGUE</div><div>PLAYERS</div></div>
  <div><div class="empty-panel-container"><p>Team panel not yet available for NBA fantasy.</p><p>Please use the Sleeper mobile app</p><div class="footer">Responsible Play</div></div></div>
</div></div></div></div></template>
<script>
  // Like Sleeper's React app: the tab (and its placeholder) render after load.
  setTimeout(() => document.body.append(document.getElementById('app').content.cloneNode(true)), 150);
</script>`;
const FAKE_TOKEN = 'e2e-fake-session-token';
const LOGGED_IN = TEAM_TAB.replace('<title>Sleeper</title>', `<title>Sleeper</title><script>localStorage.setItem('token', '${FAKE_TOKEN}')</script>`);
const LOGGED_OUT = TEAM_TAB.replace('<title>Sleeper</title>', "<title>Sleeper</title><script>localStorage.removeItem('token')</script>");
const NO_PLACEHOLDER = '<!doctype html><title>Sleeper</title><body style="margin:0;background:rgb(16,33,49)"></body>';

// Sleeper's Players tab, reduced to what the extension touches: rows with W (waiver)
// and ADD buttons whose React props carry the player id and waiver status, and
// Sleeper's own click handler, which for NBA only shows a "not yet available" toast.
const playersTab = (rows) => `<!doctype html><title>Sleeper</title>
<script>localStorage.setItem('token', '${FAKE_TOKEN}')</script>
<style>
  body { margin: 0; background: rgb(16, 33, 49); font-family: Lato, Arial, sans-serif; color: #fff; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 24px; }
  .player-action-button { padding: 8px 10px; border-radius: 50%; background: #2a3346; cursor: pointer; }
</style>
<div id="list"></div>
<script>
  window.__sleeperToasts = 0;
  window.__sleeperCards = 0;
  // React 16 delegates at the document, after any capture listener on the window.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.player-action-button')) window.__sleeperToasts++;
    if (e.target.closest('.player-meta-container, .player-details')) window.__sleeperCards++;
  });
  // React 16 internals: a fiber chain whose props sit a few fibers up from the element.
  const fiber = (props, depth) => (depth ? { memoizedProps: {}, return: fiber(props, depth - 1) } : { memoizedProps: props });
  for (const p of ${JSON.stringify(rows)}) {
    const row = document.createElement('div');
    row.className = 'row';
    const button = document.createElement('div');
    button.className = 'link-button player-action-button ' + (p.status === 'waiver' ? 'waiver' : 'add');
    button.dataset.player = p.id;
    button.innerHTML = '<span class="button-text">' + (p.status === 'waiver' ? 'W' : 'ADD') + '</span>';
    // The action component's props sit two fibers up; the row's (with the player) three.
    button.__reactInternalInstance$test = fiber({ playerId: p.id, waiverStatus: { status: p.status, clearTime: 0 } }, 2);
    const meta = document.createElement('div');
    meta.className = p.trend ? 'player-details' : 'player-meta-container';
    meta.textContent = p.name;
    meta.__reactInternalInstance$test = fiber({ player: { player_id: p.id } }, 3);
    if (p.trend) {
      row.className = 'trending-list-item';
      row.append(meta);
    } else {
      row.append(button, meta);
    }
    document.getElementById('list').append(row);
  }
</script>`;

// Sleeper's NBA Players table (inspected 2026-10-22), reduced to its stateful
// component: per-player stats keyed by stat (`playerStatsMap`, with FPTS already
// scored as fpts_proj), the stat columns (`statKeys`), headers that toggle the
// sort, and a position filter. Its list component gets the filtered players,
// and each row component its player, as React props. Cells show a stat per game, as Sleeper's do.
const playersTable = (players) => `<!doctype html><meta charset="utf-8"><title>Sleeper</title>
<style>
  body { margin: 0; background: rgb(16, 33, 49); font-family: Lato, Arial, sans-serif; color: #fff; }
  .integration-players-panel { position: absolute; left: 264px; top: 100px; width: 800px; }
  .stat-key-header, .player-list-item { display: flex; gap: 8px; padding: 10px 24px; }
  .stat-key-header { padding-left: 184px; }
  .integration-players-panel .stat-key-header { padding-left: 176px; }
  .player-list-item { width: 796px; overflow: hidden; box-sizing: border-box; padding: 0; gap: 0; }
  .owner-cell { flex: 0 0 32px; margin-left: 9px; }
  .player-meta-container { flex: 0 1 auto; min-width: 90px; white-space: nowrap; overflow: hidden; }
  .label, .cell { display: flex; align-items: center; flex: 0 0 60px; margin-left: 2px; cursor: pointer; font-size: 12px; }
  .cell { justify-content: center; }
  .stat-key-header { gap: 0; padding-top: 0; padding-bottom: 0; }
  .label span { text-transform: uppercase; }
  .name { width: 160px; }
  .filters button { margin: 0 4px 8px 24px; }
</style>
<div class="integration-players-panel"><div class="filters"><button data-pos="ALL">ALL</button><button data-pos="PG">PG</button></div>
  <div class="player-table"><div class="table-header"><div class="stat-key-header nba"></div></div><div class="ReactVirtualized__Grid"></div></div></div>
<script>
  const LABELS = { fpts_proj: 'FPTS', sp: 'MIN', pts: 'PTS', tpm: '3PM', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' };
  const PLAYERS = ${JSON.stringify(players)};
  // Rostered players show their owner under the name, which makes the name area wider.
  const OWNERS = Object.fromEntries(PLAYERS.filter((p) => p.owner).map((p) => [p.id, p.owner]));
  const fiberOf = (props, depth = 0) => (depth ? { memoizedProps: {}, return: fiberOf(props, depth - 1) } : { memoizedProps: props });
  const panel = {
    props: { leagueId: '${LEAGUE}', sport: 'nba', scoringSettings: { pts: 1, reb: 1 } },
    state: {
      playerStatsMap: Object.fromEntries(PLAYERS.map((p) => [p.id, p.stats])),
      // Sleeper's NBA projection columns; the ones a test doesn't set print "-".
      statKeys: ['fpts_proj', 'sp', 'pts', 'tpm', 'reb', 'ast', 'stl', 'blk', 'to'], statType: 'proj', sort: 'fpts_proj', positionFilter: 'ALL',
    },
    setState(update) {
      this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) };
      render();
      this.componentDidUpdate?.();
    },
  };
  function render() {
    const { playerStatsMap: map, statKeys, sort, positionFilter } = panel.state;
    document.querySelector('.stat-key-header').innerHTML = statKeys.map((k) => '<div class="label nba" data-key="' + k + '"><span>' + (LABELS[k] || k) + '</span></div>').join('');
    const view = PLAYERS.filter((p) => positionFilter === 'ALL' || p.pos === positionFilter).map((p) => ({ player_id: p.id }));
    if (sort) view.sort((a, b) => (map[b.player_id][sort] || -1) - (map[a.player_id][sort] || -1));
    const grid = document.querySelector('.ReactVirtualized__Grid');
    grid.__reactInternalInstance$test = fiberOf({ players: view, playerStatsMap: map }, 3);
    grid.innerHTML = view.map(({ player_id: id }) => '<div class="player-list-item" data-id="' + id + '"><div class="owner-cell"></div><div class="player-meta-container">' + id + (OWNERS[id] ? ' → ' + OWNERS[id] : '') + '</div>' +
      statKeys.map((k) => '<div class="cell nba">' + (map[id][k] == null ? '-' : (map[id][k] / (map[id].gp || 1)).toFixed(1)) + '</div>').join('') + '</div>').join('');
    for (const row of grid.children) row.__reactInternalInstance$test = { memoizedProps: {}, return: { memoizedProps: { player: { player_id: row.dataset.id } } } };
  }
  document.querySelector('.stat-key-header').addEventListener('click', (e) => {
    const key = e.target.closest('.label')?.dataset.key;
    if (key) panel.setState({ sort: panel.state.sort === key ? '' : key });
  });
  document.querySelector('.filters').addEventListener('click', (e) => {
    if (e.target.dataset.pos) panel.setState({ positionFilter: e.target.dataset.pos });
  });
  render();
  // React 16 internals: the panel div's fiber returns to the component's.
  document.querySelector('.integration-players-panel').__reactInternalInstance$test = { memoizedProps: {}, return: { memoizedProps: panel.props, stateNode: panel } };
</script>`;

// Sleeper's left sidebar, reduced to its league links: the item component's props
// (league, selectLeague) and the router's sit a few fibers up from the link, and
// Sleeper's own handler sends every league to /leagues/<id>.
const NFL_LEAGUE = '1354521766382292992';
const leagueNav = `<!doctype html><title>Sleeper</title>
<div id="nav"></div>
<script>
  window.__sleeperNav = [];
  window.__selected = [];
  const router = { push: (path) => history.pushState({}, '', path) };
  const fiber = (props, depth, rest) => (depth ? { memoizedProps: {}, return: fiber(props, depth - 1, rest) } : { memoizedProps: props, return: rest });
  for (const [id, sport] of [['${NFL_LEAGUE}', 'nfl'], ['${LEAGUE}', 'nba']]) {
    const link = document.createElement('a');
    link.className = 'link-button nav-league-item-wrapper';
    link.href = '/';
    link.dataset.sport = sport;
    link.innerHTML = '<div class="nav-league-item"><div class="league-title">' + sport + '</div></div>';
    const item = { league: { league_id: id, sport }, selectLeague: (x) => window.__selected.push(x), closeNavbar: () => {} };
    link.__reactInternalInstance$test = fiber(item, 2, fiber({ router, params: {} }, 5));
    document.getElementById('nav').append(link);
  }
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.nav-league-item-wrapper');
    if (!link) return;
    e.preventDefault();
    window.__sleeperNav.push(link.dataset.sport);
    history.pushState({}, '', '/leagues/' + link.__reactInternalInstance$test.return.return.memoizedProps.league.league_id);
  });
</script>`;

// Sleeper's own NFL Team tab, reduced to what Optimize lineup touches: the header's
// WAIVER and TRADE buttons, and a Team component whose React-style props hold the
// lineup and save actions, with one projection per roster row. updateMatchupLeg is
// recorded instead of saved, and can be told to refuse.
const NFL_TEAM_URL = `https://sleeper.com/leagues/${NFL_LEAGUE}/team`;
const NFL_PLAYERS = {
  qbA: ['Alpha QB', 'QB', 'KC', 22], rbPlayed: ['Early RB', 'RB', 'DET', 5], wrA: ['Alpha WR', 'WR', 'SEA', 9],
  rbB: ['Beta RB', 'RB', 'NYJ', 7], wrB: ['Beta WR', 'WR', 'MIA', 8],
  qbB: ['Beta QB', 'QB', 'LAR', 18, 'Questionable'], wrC: ['Gamma WR', 'WR', 'GB', 14],
  teOut: ['Hurt TE', 'TE', 'NYG', 20, 'Out'], rbBye: ['Bye RB', 'RB', 'CHI', null],
};
const nflTeamTab = () => `<!doctype html><title>Sleeper</title>
<style>
  body { margin: 0; background: rgb(16, 33, 49); font-family: Lato, Arial, sans-serif; color: #fff; }
  .user-tab-menu { width: 680px; margin: 40px; padding: 20px; background: rgb(36, 45, 60); border-radius: 12px; }
  .user-tab-menu .row { display: flex; justify-content: space-between; align-items: center; }
  .actions { display: flex; }
  .btn-container { display: flex; flex-direction: column; align-items: center; width: 40px; height: 54px; margin-left: 16px; cursor: pointer; }
  .btn { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 40px; background: rgb(58, 70, 91); }
  .btn-text { margin-top: 4px; font-size: 10px; }
  .team-roster-item { padding: 6px 0; }
</style>
<div class="user-tab-menu"><div class="row"><b>Lou Point Conversion</b><div class="actions">
  <div class="btn-container space"><div class="btn">W</div><div class="btn-text">WAIVER</div></div>
  <div class="btn-container space"><div class="btn">T</div><div class="btn-text">TRADE</div></div>
</div></div></div>
<div class="team-roster"></div>
<script>
  window.__nflSaves = [];
  window.__nflFail = null;
  const players = ${JSON.stringify(NFL_PLAYERS)};
  const scoring = { rec_yd: 0.1 };
  const team = {
    memoizedProps: {
      sport: 'nfl', leagueId: '${NFL_LEAGUE}', round: 7, rosterId: 4, isTeamOwner: true, disableEdit: false,
      league: { status: 'in_season' },
      roster: { roster_id: 4, players: Object.keys(players), reserve: [], taxi: [] },
      hasTeamPlayedMap: { DET: 'complete' },
      playersMap: Object.fromEntries(Object.entries(players).map(([id, [name, pos, nflTeam, , injury]]) => [id, {
        first_name: name.split(' ')[0], last_name: name.split(' ')[1], position: pos, fantasy_positions: [pos], team: nflTeam, injury_status: injury || null,
      }])),
      updateMatchupLeg: async (...args) => {
        window.__nflSaves.push(args);
        if (window.__nflFail) return { errors: [window.__nflFail] };
        team.stateNode.state.starters = team.stateNode.state.starters.map((s, i) => ({ ...s, playerId: args[4][i] }));
        return {};
      },
      rosterUpdateStarters: async () => ({ errors: ['not in season'] }),
    },
    stateNode: { state: { starters: [['QB', 'qbA'], ['RB', 'rbPlayed'], ['WR', 'wrA'], ['FLEX', 'rbB'], ['SUPER_FLEX', 'wrB']]
      .map(([slotPosition, playerId]) => ({ slotPosition, playerId })) } },
  };
  window.__nflTeam = team;
  const roster = document.querySelector('.team-roster');
  roster.__reactInternalInstance$test = { memoizedProps: {}, return: team };
  for (const [id, [name, , , proj]] of Object.entries(players)) {
    const row = document.createElement('div');
    row.className = 'team-roster-item';
    row.innerHTML = '<span class="player-name">' + name + '</span> <div class="projections">' + (proj ?? '-') + '</div>';
    row.querySelector('.projections').__reactInternalInstance$test = { memoizedProps: {}, return: { memoizedProps: {
      playerId: id, scoringSettings: scoring, proj: proj == null ? undefined : { opponent: 'OPP', stats: { rec_yd: proj * 10 } },
    } } };
    roster.append(row);
  }
</script>`;

let context;
let page;
const pageErrors = [];
let documentBody = LOGGED_OUT;

// Stand-in for Sleeper's authenticated GraphQL: everything that carries the
// session token is answered here and recorded, so tests never touch a real lineup.
const sleeper = {
  me: null, // user id of the roster under test
  legs: {}, // round -> matchup legs
  mutations: [],
  failNextMutation: false,
  rosters: null, // league rosters as the mock's Sleeper currently has them
  rostersLoading: null,
  claims: [], // waiver claims submitted through the mock
  injured: new Set(), // player ids the players feed reports as Out
  // When set, each team's first game of the week is reported as finished a few
  // hours ago, with projections standing in as stats, so Lock-In has something to lock.
  midWeek: false,
  finished: new Set(),
  // When set, it is week 1 of the regular season and no game has tipped off yet.
  beforeTipoff: false,
  // When set, rewrites the weekly projection rows (and so mid-week stats, which stand in from them).
  projections: null,
  // When set, Sleeper turns down the session: every logged-in call gets a 401.
  rejectSession: false,
};

// Picks each team's first game of week 1 up front, since the page loads scores
// and stats in parallel and both mocks need to agree.
async function startMidWeek() {
  const res = await fetch('https://sleeper.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query scores { scores(sport: "nba", season_type: "regular", season: "2026", week: 1) { game_id start_time metadata } }' }),
  });
  const { data } = await res.json();
  const firstByTeam = {};
  for (const g of data.scores.sort((a, b) => a.start_time - b.start_time)) {
    for (const t of [g.metadata?.home_team?.team, g.metadata?.away_team?.team]) firstByTeam[t] ??= g.game_id;
  }
  sleeper.finished = new Set(Object.values(firstByTeam));
  sleeper.midWeek = true;
}

function fakeMidWeek(scores) {
  for (const g of scores) {
    if (!sleeper.finished.has(g.game_id)) continue;
    g.status = 'complete';
    g.start_time = Date.now() - 3 * 3600e3;
  }
  return scores;
}

// Every game moves a day past now, keeping their order, and none has a score.
function fakeBeforeTipoff(scores) {
  const shift = Math.max(0, Date.now() + 24 * 3600e3 - Math.min(...scores.map((g) => g.start_time)));
  for (const g of scores) {
    g.status = 'pre_game';
    g.start_time += shift;
  }
  return scores;
}
async function seedLegs(round) {
  if (sleeper.legs[round]) return;
  const res = await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/matchups/${round}`);
  sleeper.legs[round] = (await res.json()).map((m) => ({
    leg: round, round, matchup_id: m.matchup_id, roster_id: m.roster_id, starters: m.starters,
    points: null, proj_points: 157.23, max_points: null, custom_points: null, starters_games: {}, subs: null,
  }));
}
async function answerGraphql(route) {
  const req = route.request();
  const auth = req.headers().authorization;
  if (!auth) {
    // Public queries like scores stay live, optionally doctored for mid-week or before tip-off.
    if (!(sleeper.midWeek || sleeper.beforeTipoff) || !/query scores\b/.test(req.postDataJSON().query)) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    (sleeper.midWeek ? fakeMidWeek : fakeBeforeTipoff)(body.data.scores);
    return route.fulfill({ response: res, json: body });
  }
  assert.ok(auth.startsWith(FAKE_TOKEN), 'sends the page session token');
  if (sleeper.rejectSession) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"unauthorized"}' });
  const { query, variables } = req.postDataJSON();
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (/query me\b/.test(query)) return json({ data: { me: { user_id: sleeper.me } } });
  // Rosters live in the mock once fetched, so saves survive a reload like they do on Sleeper.
  // Concurrent calls share one fetch, so a late response can't overwrite a save.
  if (!sleeper.rosters) {
    sleeper.rostersLoading ??= fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`)
      .then((res) => res.json())
      .then((rosters) => {
        // The tests expect full active rosters with empty IR; the live league can move players to IR.
        for (const r of rosters) r.reserve = [];
        sleeper.rosters = rosters;
        sleeper.rostersLoading = null;
      });
    await sleeper.rostersLoading;
  }
  if (/query league_rosters\b/.test(query)) return json({ data: { league_rosters: sleeper.rosters } });
  if (/query league_transactions_filtered\b/.test(query)) {
    return json({ data: { league_transactions_filtered: sleeper.claims.filter((c) => c.status === 'pending') } });
  }
  const pairs = (keys = [], values = []) => (keys.length ? Object.fromEntries(keys.map((k, i) => [k, values[i]])) : null);
  if (/mutation (submit_waiver_claim|league_create_transaction)\b/.test(query)) {
    sleeper.mutations.push({ query, variables });
    const tx = {
      transaction_id: String(1000 + sleeper.mutations.length), leg: 1, roster_ids: variables.v_adds,
      adds: pairs(variables.k_adds, variables.v_adds), drops: pairs(variables.k_drops, variables.v_drops),
      settings: pairs(variables.k_settings, variables.v_settings),
    };
    if (/submit_waiver_claim/.test(query)) {
      sleeper.claims.push({ ...tx, type: 'waiver', status: 'pending' });
      return json({ data: { submit_waiver_claim: tx } });
    }
    const roster = sleeper.rosters.find((r) => r.roster_id === variables.v_adds[0]);
    roster.players = [...roster.players.filter((id) => !variables.k_drops.includes(id)), ...variables.k_adds];
    return json({ data: { league_create_transaction: { ...tx, type: 'free_agent', status: 'complete' } } });
  }
  if (/mutation (update|cancel)_waiver_claim\b/.test(query)) {
    sleeper.mutations.push({ query, variables });
    const claim = sleeper.claims.find((c) => c.transaction_id === query.match(/transaction_id: "(\d+)"/)[1]);
    if (/update_waiver_claim/.test(query)) claim.settings = pairs(variables.k_settings, variables.v_settings);
    else claim.status = 'cancelled';
    return json({ data: { [/update/.test(query) ? 'update_waiver_claim' : 'cancel_waiver_claim']: claim } });
  }
  if (/mutation roster_update_reserve\b/.test(query)) {
    sleeper.mutations.push({ query, variables });
    const roster = sleeper.rosters.find((r) => r.roster_id === Number(query.match(/roster_id: (\d+)/)[1]));
    roster.reserve = JSON.parse(query.match(/reserve: (\[[^\]]*\])/)[1]);
    return json({ data: { roster_update_reserve: roster } });
  }
  if (/mutation roster_update_taxi\b/.test(query)) {
    sleeper.mutations.push({ query, variables });
    const rosterId = Number(query.match(/roster_id: (\d+)/)[1]);
    const roster = sleeper.rosters.find((r) => r.roster_id === rosterId);
    roster.taxi = JSON.parse(query.match(/taxi: (\[[^\]]*\])/)[1]);
    return json({ data: { roster_update_taxi: roster } });
  }
  if (/query league_transactions_by_player\b/.test(query)) return json({ data: { league_transactions_by_player: [] } });
  const round = Number(query.match(/round: (\d+)/)?.[1]);
  if (!round) return json({ errors: [{ message: `unmocked: ${query.slice(0, 60)}` }] });
  await seedLegs(round);
  if (/query matchup_legs\b/.test(query)) return json({ data: { matchup_legs: sleeper.legs[round] } });
  if (/mutation update_matchup_leg\b/.test(query)) {
    sleeper.mutations.push({ query, variables });
    if (sleeper.failNextMutation) {
      sleeper.failNextMutation = false;
      return json({ errors: [{ message: 'Player is locked', path: ['update_matchup_leg'] }], data: null });
    }
    const rosterId = Number(query.match(/roster_id: (\d+)/)[1]);
    const leg = sleeper.legs[round].find((l) => l.roster_id === rosterId);
    leg.starters = JSON.parse(query.match(/starters: (\[[^\]]*\])/)[1]);
    if (variables.starters_games) leg.starters_games = JSON.parse(variables.starters_games);
    return json({ data: { update_matchup_leg: leg } });
  }
  return json({ errors: [{ message: `unmocked: ${query.slice(0, 60)}` }] });
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await context.route('https://sleeper.com/**', (route) =>
    route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: documentBody })
      : route.continue());
  await context.route('https://sleeper.com/graphql', answerGraphql);
  await context.route('https://api.sleeper.app/v1/players/nba', async (route) => {
    if (!sleeper.injured.size) return route.continue();
    const res = await route.fetch();
    const players = await res.json();
    for (const id of sleeper.injured) players[id].injury_status = 'Out';
    return route.fulfill({ response: res, json: players });
  });
  // Player card game logs arrive late, as on a slow connection, so tests see the loading state.
  await context.route(/api\.sleeper\.app\/(stats|projections)\/nba\/player\//, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return route.fallback();
  });
  await context.route('https://api.sleeper.app/v1/state/nba', async (route) => {
    // Both doctored weeks are week 1, whatever week it really is.
    if (!(sleeper.midWeek || sleeper.beforeTipoff)) return route.continue();
    const res = await route.fetch();
    return route.fulfill({ response: res, json: { ...(await res.json()), season_type: 'regular', week: 1, display_week: 1 } });
  });
  await context.route(/api\.sleeper\.app\/projections\/nba\/\d+\/\d+/, async (route) => {
    if (!sleeper.projections) return route.continue();
    const res = await route.fetch();
    return route.fulfill({ response: res, json: sleeper.projections(await res.json()) });
  });
  await context.route('https://api.sleeper.app/stats/nba/**', async (route) => {
    // Only the weekly stats are doctored; the player card's own stats go through.
    if (!/\/stats\/nba\/\d+\/\d+/.test(route.request().url())) return route.fallback();
    if (sleeper.beforeTipoff) return route.fulfill({ json: [] });
    if (!sleeper.midWeek) return route.continue();
    const url = route.request().url().replace('/stats/', '/projections/');
    const raw = await (await fetch(url)).json();
    const projections = sleeper.projections ? sleeper.projections(raw) : raw;
    const stats = projections.filter((p) => sleeper.finished.has(p.game_id)).map((p) => ({ ...p, category: 'stat' }));
    return route.fulfill({ json: stats });
  });
  // Checks every frame what the user would see: Sleeper's placeholder, or a
  // half-built panel (anything before the first full render).
  await context.addInitScript(() => {
    window.__paint = { placeholder: false, partial: false, full: false };
    const tick = () => {
      const ph = document.querySelector('.empty-panel-container');
      if (ph && ph.offsetParent !== null) window.__paint.placeholder = true;
      const root = document.getElementById('sleeper-nba-panel')?.shadowRoot;
      if (root && !window.__paint.full) {
        if (root.querySelector('.card, .mu-head, .msg.error')) window.__paint.full = true;
        else if (root.querySelector('.root')?.childElementCount) window.__paint.partial = true;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});

after(async () => {
  await context?.close();
  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
});

test('fills the empty Team tab in place', async () => {
  await page.goto(TEAM_URL);
  await page.locator(panel('.card .days')).first().waitFor({ timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => window.__paint), { placeholder: false, partial: false, full: true },
    "never paints Sleeper's placeholder or a half-built panel");
  assert.equal(await page.locator('.empty-panel-container').isVisible(), false, 'placeholder hidden');
  const box = await page.locator('#sleeper-nba-panel').boundingBox();
  const tabs = await page.locator('.center-tab-selector').boundingBox();
  assert.ok(box.y >= tabs.y + tabs.height - 1 && box.x >= 264 && box.x + box.width <= 1064, 'sits under the tab bar inside the center panel');
  assert.ok(box.y + box.height <= 798 + 1, 'does not overflow the center panel');
});

test('shows starters with a full week of days and real projections', async () => {
  const headings = await page.locator(panel('h3')).allTextContents();
  assert.deepEqual(headings.slice(0, 2), ['Starters', 'Bench']);
  for (const h of ['Injured Reserve', 'Taxi Squad', 'Draft Picks']) assert.ok(headings.includes(h), `missing ${h}`);
  const firstDays = page.locator(panel('.card')).first().locator('.day');
  assert.equal(await firstDays.count(), 7);
  const values = await page.locator(panel('.card .cell .v')).allTextContents();
  assert.ok(values.some((v) => /^\d+\.\d\d$/.test(v)), 'some game cells show projected points');
  const times = await page.locator(panel('.time')).allTextContents();
  assert.ok(times.some((t) => /^\d{1,2}:\d\d(am|pm)$/.test(t)), 'game times come from the scores query');
  assert.match(await page.locator(panel('.week-label')).textContent(), /Week \d+\s*[A-Z]{3} \d+-/);
  assert.match(await page.locator(panel('.team-card')).textContent(), /proj \d+\.\d\d/);
  assert.match(await page.locator(panel('.line2')).first().textContent(), /\d+% Start\s*\|\s*\d+% Rostered/);
  await page.screenshot({ path: `${OUT}team.png` });
  await page.locator(panel('.body')).evaluate((b) => { b.scrollTop = b.scrollHeight; });
  await page.screenshot({ path: `${OUT}team-bottom.png` });
});

test('team picker switches roster and persists across reloads', async () => {
  const select = page.locator(panel('select'));
  const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
  const before = await page.locator(panel('.team-name')).textContent();
  await select.selectOption(values[1]);
  await page.waitForFunction((b) => document.querySelector('#sleeper-nba-panel').shadowRoot.querySelector('.team-name').textContent !== b, before);
  await page.reload();
  await page.locator(panel('.card .days')).first().waitFor();
  assert.equal(await page.locator(panel('select')).inputValue(), values[1]);
});

test('week navigation loads the next week', async () => {
  const label = page.locator(panel('.week-label b'));
  const before = await label.textContent();
  await page.locator(panel('[data-action="next"]')).click();
  await page.waitForFunction((b) => document.querySelector('#sleeper-nba-panel').shadowRoot.querySelector('.week-label b').textContent !== b, before);
  await page.locator(panel('.card .days')).first().waitFor();
  await page.locator(panel('[data-action="prev"]')).click();
  await page.waitForFunction((b) => document.querySelector('#sleeper-nba-panel').shadowRoot.querySelector('.week-label b').textContent === b, before);
});

test('logs every API call, including the GraphQL query', async () => {
  await page.locator(panel('[data-tab="api"]')).click();
  await page.locator(panel('ol.calls code')).first().waitFor();
  const paths = await page.locator(panel('ol.calls code')).allTextContents();
  for (const p of [`/v1/league/${LEAGUE}/rosters`, '/v1/players/nba', '/projections/nba/', '/stats/nba/', '/players/nba/research/', 'graphql scores', '/traded_picks']) {
    assert.ok(paths.some((x) => x.includes(p)), `missing ${p}`);
  }
  assert.ok(!(await page.locator(panel('.status.bad')).count()), 'no failed calls');
  await page.locator(panel('ol.calls summary')).filter({ hasText: 'graphql scores' }).first().click();
  await page.locator(panel('pre.request')).waitFor();
  await page.screenshot({ path: `${OUT}api.png` });
  await page.locator(panel('[data-tab="page"]')).click();
});

test('unmounts on other league tabs and restores the placeholder', async () => {
  await page.evaluate((id) => history.pushState({}, '', `/leagues/${id}/league`), LEAGUE);
  await page.locator('#sleeper-nba-panel').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.empty-panel-container').isVisible(), true);
  await page.evaluate(() => history.back());
  await page.locator(panel('.card')).first().waitFor();
});

test('floats when the page has no placeholder to fill', async () => {
  documentBody = NO_PLACEHOLDER;
  await page.goto(TEAM_URL);
  await page.locator('#sleeper-nba-panel.floating').waitFor({ timeout: 10000 });
  await page.locator(panel('.card .days')).first().waitFor();
  await page.screenshot({ path: `${OUT}floating.png` });
  documentBody = LOGGED_OUT;
});

const shadowText = (sel) => page.locator(panel(sel)).textContent();

test('logged in: swaps a bench player into the lineup', async () => {
  documentBody = LOGGED_IN;
  const rosters = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`)).json();
  const users = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/users`)).json();
  const mine = users.find((u) => u.display_name === 'louhow');
  sleeper.me = mine.user_id;
  const myRoster = rosters.find((r) => r.owner_id === mine.user_id);

  await page.goto(TEAM_URL);
  await page.locator(panel('select')).selectOption(String(myRoster.roster_id));
  await page.locator(panel('button.slot')).first().waitFor({ timeout: 30000 });
  assert.match(await shadowText('.rhead:first-of-type .hint'), /Tap a position to update your lineup/);
  assert.match(await shadowText('.team-card'), /proj 157\.23/, 'uses the server projection from matchup_legs');

  // Pick the first bench player, then the first highlighted starter slot.
  const benchSpot = page.locator(panel('.card button.slot.bn')).first();
  const benchId = (await benchSpot.getAttribute('data-spot')).slice(2);
  await benchSpot.click();
  await page.locator(panel('.card.selected')).waitFor();
  const target = page.locator(panel('.card.target button.slot[data-spot^="s:"]')).first();
  assert.ok(await target.count(), 'some starter slot accepts the bench player');
  assert.ok(await page.locator(panel('.card.dim')).count(), 'ineligible spots are dimmed');
  await page.screenshot({ path: `${OUT}swap-picking.png` });
  const slotIndex = Number((await target.getAttribute('data-spot')).slice(2));
  await target.click();

  await page.locator(panel('.notice.ok')).waitFor();
  const mutation = sleeper.mutations.at(-1);
  assert.match(mutation.query, new RegExp(`roster_id: ${myRoster.roster_id}, leg: 1, round: 1`));
  const saved = JSON.parse(mutation.query.match(/starters: (\[[^\]]*\])/)[1]);
  assert.equal(saved[slotIndex], benchId, 'bench player saved into the chosen slot');
  assert.deepEqual(mutation.variables, {}, 'no Lock-In picks are sent with a plain swap');
  await page.locator(panel(`button.slot[data-spot="s:${slotIndex}"]`)).waitFor();
  const starterNames = await page.locator(panel('.card button.slot[data-spot^="s:"]')).evaluateAll((els) =>
    els.map((el) => el.closest('.card').querySelector('.name').textContent));
  const players = await (await fetch('https://api.sleeper.app/v1/players/nba')).json();
  assert.equal(starterNames[slotIndex], players[benchId].full_name, 'refetched lineup shows the new starter');
  await page.screenshot({ path: `${OUT}swap-saved.png` });
  await page.locator(panel('.notice.ok')).waitFor({ state: 'detached', timeout: 5000 });
});

test('logged in: a refused save shows the error and Escape cancels a pick', async () => {
  sleeper.failNextMutation = true;
  await page.locator(panel('.card button.slot.bn')).first().click();
  await page.locator(panel('.card.target button.slot')).first().click();
  await page.locator(panel('.notice.error')).waitFor();
  assert.match(await shadowText('.notice.error'), /Player is locked/);

  await page.locator(panel('.card button.slot.bn')).first().click();
  await page.locator(panel('.card.selected')).waitFor();
  await page.keyboard.press('Escape');
  await page.locator(panel('.card.selected')).waitFor({ state: 'detached' });
});

test('logged in: the API log tags authenticated calls and never shows the token', async () => {
  await page.locator(panel('[data-tab="api"]')).click();
  await page.locator(panel('ol.calls code')).first().waitFor();
  const paths = await page.locator(panel('ol.calls code')).allTextContents();
  for (const p of ['graphql me', 'graphql matchup_legs (week 1)', 'graphql update_matchup_leg (week 1)']) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
  assert.ok(await page.locator(panel('.auth')).count());
  await page.locator(panel('ol.calls summary')).filter({ hasText: 'update_matchup_leg' }).first().click();
  await page.locator(panel('pre.request')).first().waitFor();
  const html = await page.locator('#sleeper-nba-panel').evaluate((h) => h.shadowRoot.innerHTML);
  assert.ok(!html.includes(FAKE_TOKEN), 'token never rendered');
  await page.locator(panel('[data-tab="page"]')).click();
  documentBody = LOGGED_OUT;
});

test('matchup: fills the Matchup tab with both teams', async () => {
  documentBody = LOGGED_OUT;
  await page.goto(MATCHUP_URL);
  await page.locator(panel('.mu-head')).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.empty-panel-container').isVisible(), false);
  assert.match(await page.locator(panel('[data-tab="page"]')).textContent(), /Matchup/);
  const head = await shadowText('.mu-head');
  assert.match(head, /\d+% WIN.*VS.*\d+% WIN/s);
  assert.match(head, /\(#\d+\)/, 'standings rank');
  assert.equal(await page.locator(panel('.mu-row')).first().locator('.mp').count(), 2);
  assert.ok(await page.locator(panel('.chip img')).count(), 'team logos for the week');
  assert.ok(!(await page.locator(panel('[data-lock]')).count()), 'no lock controls when logged out');
  await page.screenshot({ path: `${OUT}matchup.png` });
});

test('matchup: switching to Team keeps the session and data', async () => {
  const calls = await page.locator(panel('[data-tab="api"] .count')).textContent();
  await page.evaluate((id) => history.pushState({}, '', `/leagues/${id}/team`), LEAGUE);
  await page.locator(panel('.team-card')).waitFor();
  assert.equal(await page.locator(panel('[data-tab="api"] .count')).textContent(), calls, 'no refetch');
});

test('matchup: locks in a finished game for your starter', async () => {
  documentBody = LOGGED_IN;
  await startMidWeek();
  sleeper.legs = {};
  const users = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/users`)).json();
  const rosters = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`)).json();
  sleeper.me = users.find((u) => u.display_name === 'louhow').user_id;
  const myRoster = rosters.find((r) => r.owner_id === sleeper.me);

  await page.goto(MATCHUP_URL);
  await page.locator(panel('select')).selectOption(String(myRoster.roster_id));
  const open = page.locator(panel('.mp.mine button.lk.open'));
  await open.first().waitFor({ timeout: 30000 });
  assert.ok(!(await page.locator(panel('.mp.theirs button.lk')).count()), "no lock buttons on the opponent's side");
  await page.screenshot({ path: `${OUT}lock-open.png` });

  const ref = await open.first().getAttribute('data-lock');
  const [rosterId, playerId] = ref.split(':');
  assert.equal(Number(rosterId), myRoster.roster_id);
  const before = sleeper.mutations.length;
  await open.first().click();
  const go = page.locator(panel(`[data-lock-confirm="${ref}"]`));
  assert.match(await go.textContent(), /^Lock \d+\.\d\d$/);
  assert.notEqual(await go.textContent(), 'Lock 0.00', 'the finished game has stats');
  assert.equal(sleeper.mutations.length, before, 'nothing saved before confirming');
  await page.screenshot({ path: `${OUT}lock-confirm.png` });
  await go.click();

  await page.locator(panel('.notice.ok')).waitFor();
  assert.match(await shadowText('.notice.ok'), /^Locked .+: \d+\.\d\d$/);
  assert.equal(sleeper.mutations.length, before + 1);
  const { query, variables } = sleeper.mutations.at(-1);
  const locks = JSON.parse(variables.starters_games);
  assert.ok(sleeper.finished.has(locks[playerId]), 'locks the finished game');
  const leg = sleeper.legs[1].find((l) => l.roster_id === myRoster.roster_id);
  assert.match(query, new RegExp(`starters: ${JSON.stringify(leg.starters).replace(/[[\]]/g, '\\$&')}`), 'lineup unchanged');
  const card = page.locator(panel('.mp.mine.is-locked'));
  await card.first().waitFor();
  assert.equal(await card.first().locator('.lk.locked').count(), 1, 'shows the lock');
  const locked = (await card.first().locator('.mp-pts b').textContent()).trim();
  assert.match(await page.locator(panel('.mu-team.mine .mu-pts')).textContent(), new RegExp(locked.replace('.', '\\.')), 'header counts the locked game');
  await page.screenshot({ path: `${OUT}lock-done.png` });
  sleeper.midWeek = false;
  documentBody = LOGGED_OUT;
});

async function openMyTeam(url) {
  const users = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/users`)).json();
  const rosters = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`)).json();
  sleeper.me = users.find((u) => u.display_name === 'louhow').user_id;
  const myRoster = rosters.find((r) => r.owner_id === sleeper.me);
  await page.goto(url);
  await page.locator(panel('select')).selectOption(String(myRoster.roster_id));
  await page.locator(panel('.taxi-head .hint')).waitFor({ timeout: 30000 });
  return myRoster;
}

// Clicks bench players until one can trade with a taxi player; returns its id.
async function pickTaxiEligibleBenchPlayer() {
  const bench = page.locator(panel('.card button.slot.bn[data-spot^="b:"]'));
  for (let i = 0; i < await bench.count(); i++) {
    const ref = await bench.nth(i).getAttribute('data-spot');
    await bench.nth(i).click();
    await page.locator(panel(`.card.selected [data-spot="${ref}"]`)).waitFor();
    if (await page.locator(panel('.card.target button.slot.tx')).count()) return ref.slice(2);
    await page.keyboard.press('Escape');
    await page.locator(panel('.card.selected')).waitFor({ state: 'detached' });
  }
  return null;
}

test('taxi: before the season, an eligible bench player trades places with a taxi player', async () => {
  documentBody = LOGGED_IN;
  sleeper.midWeek = false;
  sleeper.beforeTipoff = true;
  const myRoster = await openMyTeam(TEAM_URL);
  assert.match(await shadowText('.taxi-head .hint'), /can move to taxi until the first game of the regular season tips off/);

  const benchId = await pickTaxiEligibleBenchPlayer();
  assert.ok(benchId, 'some bench player is taxi-eligible');
  const target = page.locator(panel('.card.target button.slot.tx[data-spot^="t:"]')).first();
  const taxiId = (await target.getAttribute('data-spot')).slice(2);
  await page.screenshot({ path: `${OUT}taxi-picking.png` });
  const before = sleeper.mutations.length;
  await target.click();

  await page.locator(panel('.notice.ok')).waitFor();
  const saved = sleeper.mutations.slice(before);
  assert.equal(saved.length, 1, 'only taxi changes; starters untouched');
  assert.match(saved[0].query, new RegExp(`roster_update_taxi\\(league_id: "${LEAGUE}", roster_id: ${myRoster.roster_id}, taxi: `));
  const taxi = JSON.parse(saved[0].query.match(/taxi: (\[[^\]]*\])/)[1]);
  assert.ok(taxi.includes(benchId) && !taxi.includes(taxiId), 'bench player in, taxi player out');
  assert.equal(taxi.length, myRoster.taxi.length);
  assert.ok(await page.locator(panel(`[data-spot="t:${benchId}"]`)).count(), 'shows on taxi');
  assert.ok(await page.locator(panel(`[data-spot="b:${taxiId}"]`)).count(), 'displaced player is on the bench');
  const message = await shadowText('.notice.ok');
  assert.match(message, /^Saved: /);
  assert.match(message, / to taxi\b/, 'says who went to taxi');
  assert.match(message, / to bench\b/, 'says who went to the bench');
  await page.screenshot({ path: `${OUT}taxi-saved.png` });

  // A reload reads rosters from Sleeper itself, not the CDN-cached public endpoint.
  await page.reload();
  await page.locator(panel(`[data-spot="t:${benchId}"]`)).waitFor({ timeout: 30000 });
  assert.ok(await page.locator(panel(`[data-spot="b:${taxiId}"]`)).count(), 'still on the bench after reload');
  sleeper.beforeTipoff = false;
  documentBody = LOGGED_OUT;
});

test('taxi: after the season tips off, nothing moves onto taxi', async () => {
  documentBody = LOGGED_IN;
  sleeper.rosters = null;
  await startMidWeek();
  await openMyTeam(TEAM_URL);
  assert.match(await shadowText('.taxi-head .hint'), /Taxi is locked for the season: players can only move up to the active roster/);
  assert.equal(await pickTaxiEligibleBenchPlayer(), null, 'no bench player can go to taxi');
  assert.equal(await page.locator(panel('.card button.slot.tx')).count(), 0, 'roster is full, so taxi players have nowhere to go');
  assert.equal(await page.locator(panel('.card span.slot.tx')).count(), 3);
  await page.locator('#sleeper-nba-panel').evaluate((h) => {
    const head = h.shadowRoot.querySelector('.taxi-head');
    h.shadowRoot.querySelector('.body').scrollTop = head.offsetTop - 120;
  });
  await page.screenshot({ path: `${OUT}taxi-locked.png` });
  sleeper.midWeek = false;
  documentBody = LOGGED_OUT;
});

// Free agents for the Players tab stand-in: active NBA players on no roster in the league.
async function freeAgents(n) {
  const rosters = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`)).json();
  const rostered = new Set(rosters.flatMap((r) => r.players || []));
  const players = await (await fetch('https://api.sleeper.app/v1/players/nba')).json();
  return Object.entries(players)
    .filter(([id, p]) => p.active && p.team && p.fantasy_positions?.length && !rostered.has(id))
    .slice(0, n)
    .map(([id, p]) => ({ id, name: p.full_name }));
}

const dialogText = (sel) => page.locator(dialog(sel)).textContent();

test('waivers: W on the Players tab opens a bid dialog and places a FAAB bid', async () => {
  sleeper.midWeek = false;
  sleeper.rosters = null;
  sleeper.claims = [];
  const users = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/users`)).json();
  sleeper.me = users.find((u) => u.display_name === 'louhow').user_id;
  const [waiverPlayer, freeAgent] = await freeAgents(2);
  documentBody = playersTab([{ ...waiverPlayer, status: 'waiver' }, { ...freeAgent, status: 'free_agent' }]);
  await page.goto(PLAYERS_URL);
  await page.waitForFunction((id) => document.documentElement.dataset.snpNbaLeague === id, LEAGUE, { timeout: 30000 });
  assert.equal(await page.locator('#sleeper-nba-panel').count(), 0, 'no panel on the Players tab');

  await page.locator(`[data-player="${waiverPlayer.id}"] .button-text`).click();
  await page.locator(dialog('.dp-row[data-drop]')).first().waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__sleeperToasts), 0, "Sleeper's own handler never sees the click");
  assert.match(await dialogText('.dialog-head'), new RegExp(`Make Waiver Bid\\s*Bid for ${waiverPlayer.name}`));
  assert.match(await dialogText('.banner'), /Your roster is full, please select a player to drop/);
  assert.match(await dialogText('.bid-form'), /\(\$\d+ remaining\)/);
  // This failed once in a full run and never again in 35 more; if it recurs, the message says where focus was.
  const focus = await page.locator(dialog('[data-bid]')).evaluate((el) => ({
    focused: el === el.getRootNode().activeElement,
    pageHasFocus: document.hasFocus(),
    documentActive: `${document.activeElement?.tagName}#${document.activeElement?.id}`,
    layerActive: el.getRootNode().activeElement?.outerHTML?.slice(0, 80) ?? null,
    layers: document.querySelectorAll('#sleeper-nba-dialog').length,
  }));
  assert.equal(focus.focused, true, `bid input focused: ${JSON.stringify(focus)}`);

  await page.locator(dialog('[data-action="submit-claim"]')).click();
  assert.match(await dialogText('.dialog-errors'), /You must select 1 player to drop/);

  const drop = page.locator(dialog('.dp-row[data-drop]')).filter({ has: page.locator('.slot.bn') }).first();
  const dropId = await drop.getAttribute('data-drop');
  await drop.click();
  await page.locator(dialog(`.dp-row.selected[data-drop="${dropId}"]`)).waitFor();
  await page.locator(dialog('[data-bid]')).fill('7');
  await page.screenshot({ path: `${OUT}waiver-bid.png` });
  const before = sleeper.mutations.length;
  await page.locator(dialog('[data-bid]')).press('Enter');

  await page.locator(dialog('.notice.ok')).waitFor();
  assert.equal(await page.locator(dialog('.dialog')).count(), 0, 'dialog closes');
  assert.match(await dialogText('.notice.ok'), new RegExp(`^\\$7 bid placed for ${waiverPlayer.name} \\(dropping .+\\)$`));
  const { query, variables } = sleeper.mutations[before];
  assert.match(query, new RegExp(`submit_waiver_claim\\(league_id: "${LEAGUE}", k_adds: \\$k_adds`));
  const myRoster = sleeper.rosters.find((r) => r.owner_id === sleeper.me);
  assert.deepEqual(variables, {
    k_adds: [waiverPlayer.id], v_adds: [myRoster.roster_id],
    k_drops: [dropId], v_drops: [myRoster.roster_id],
    k_settings: ['waiver_bid'], v_settings: [7],
  });
  await page.screenshot({ path: `${OUT}waiver-placed.png` });
});

test('waivers: the Team tab lists pending claims to rebid or cancel', async () => {
  documentBody = LOGGED_IN;
  await page.goto(TEAM_URL);
  const myRoster = sleeper.rosters.find((r) => r.owner_id === sleeper.me);
  await page.locator(panel('select')).selectOption(String(myRoster.roster_id));
  const button = page.locator(panel('button.waivers'));
  await page.waitForFunction(() => /1/.test(document.querySelector('#sleeper-nba-panel')?.shadowRoot.querySelector('button.waivers .count')?.textContent), null, { timeout: 30000 });
  await button.click();
  await page.locator(dialog('.claim')).waitFor();
  assert.match(await dialogText('.claim'), /\+.+−/s, 'shows the add and the drop');
  const [claim] = sleeper.claims;
  assert.equal(await page.locator(dialog(`[data-claim-bid="${claim.transaction_id}"]`)).inputValue(), '7');
  await page.screenshot({ path: `${OUT}waiver-claims.png` });

  await page.locator(dialog(`[data-claim-bid="${claim.transaction_id}"]`)).fill('9');
  await page.locator(dialog(`[data-claim-save="${claim.transaction_id}"]`)).click();
  await page.locator(dialog('.notice.ok')).waitFor();
  assert.match(await dialogText('.notice.ok'), /is now \$9$/);
  const update = sleeper.mutations.at(-1);
  assert.match(update.query, new RegExp(`update_waiver_claim\\(league_id: "${LEAGUE}", transaction_id: "${claim.transaction_id}", leg: 1,`));
  assert.deepEqual(update.variables, { k_settings: ['waiver_bid'], v_settings: [9] });
  assert.equal(await page.locator(dialog(`[data-claim-bid="${claim.transaction_id}"]`)).inputValue(), '9');

  const before = sleeper.mutations.length;
  await page.locator(dialog(`[data-claim-cancel="${claim.transaction_id}"]`)).click();
  await page.locator(dialog('[data-claim-cancel-keep]')).click();
  await page.locator(dialog(`[data-claim-cancel="${claim.transaction_id}"]`)).waitFor();
  assert.equal(sleeper.mutations.length, before, 'Keep leaves the claim alone');
  await page.locator(dialog(`[data-claim-cancel="${claim.transaction_id}"]`)).click();
  assert.match(await dialogText('.claim-actions.confirm'), /Cancel this claim\?/);
  await page.screenshot({ path: `${OUT}waiver-cancel-confirm.png` });
  await page.locator(dialog(`[data-claim-cancel-confirm="${claim.transaction_id}"]`)).click();
  await page.locator(dialog('.dialog-body')).filter({ hasText: 'No pending claims' }).waitFor();
  assert.match(sleeper.mutations.at(-1).query, new RegExp(`cancel_waiver_claim\\(league_id: "${LEAGUE}", leg: 1, transaction_id: "${claim.transaction_id}"\\)`));
  await page.keyboard.press('Escape');
  await page.locator(dialog('.dialog')).waitFor({ state: 'detached' });
  assert.equal(await page.locator(panel('button.waivers .count')).count(), 0, 'no pending claims left');
});

test('waivers: ADD on a free agent adds them right away, with a drop', async () => {
  const [, freeAgent] = await freeAgents(2);
  documentBody = playersTab([{ ...freeAgent, status: 'free_agent' }]);
  await page.goto(PLAYERS_URL);
  await page.waitForFunction((id) => document.documentElement.dataset.snpNbaLeague === id, LEAGUE, { timeout: 30000 });
  await page.locator(`[data-player="${freeAgent.id}"]`).click();
  await page.locator(dialog('.dp-row[data-drop]')).first().waitFor({ timeout: 30000 });
  assert.match(await dialogText('.dialog-head'), new RegExp(`Add Player\\s*Add ${freeAgent.name} to your roster`));
  assert.equal(await page.locator(dialog('[data-bid]')).count(), 0, 'no bid for a free agent');
  const drop = page.locator(dialog('.dp-row[data-drop]:not(:disabled)')).filter({ has: page.locator('.slot.bn') }).first();
  const dropId = await drop.getAttribute('data-drop');
  await drop.click();
  await page.locator(dialog('[data-action="submit-claim"]')).click();
  await page.locator(dialog('.notice.ok')).waitFor();
  assert.match(await dialogText('.notice.ok'), new RegExp(`^Added ${freeAgent.name} \\(dropping .+\\)$`));
  const { query, variables } = sleeper.mutations.at(-1);
  assert.match(query, /league_create_transaction\(league_id: "\d+", type: "free_agent", k_adds: \$k_adds/);
  assert.deepEqual(variables.k_adds, [freeAgent.id]);
  assert.deepEqual(variables.k_drops, [dropId]);
  const myRoster = sleeper.rosters.find((r) => r.owner_id === sleeper.me);
  assert.ok(myRoster.players.includes(freeAgent.id) && !myRoster.players.includes(dropId), 'roster updated');
  documentBody = LOGGED_OUT;
});

test('IR: Out players move onto IR from the bench or the lineup', async () => {
  documentBody = LOGGED_IN;
  sleeper.midWeek = false;
  sleeper.rosters = null;
  sleeper.legs = {};
  const users = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/users`)).json();
  sleeper.me = users.find((u) => u.display_name === 'louhow').user_id;
  const rosters = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`)).json();
  const myRoster = rosters.find((r) => r.owner_id === sleeper.me);
  await seedLegs(1);
  const starters = sleeper.legs[1].find((l) => l.roster_id === myRoster.roster_id).starters;
  const benchId = myRoster.players.find((id) => !starters.includes(id) && !(myRoster.taxi || []).includes(id));
  const starterId = starters[0];
  sleeper.injured = new Set([benchId, starterId]);

  await page.goto(TEAM_URL);
  await page.locator(panel('select')).selectOption(String(myRoster.roster_id));
  await page.locator(panel('[data-action="refresh"]')).click(); // refetch players with the injuries
  await page.locator(panel('.ir-head .hint')).waitFor({ timeout: 30000 });
  assert.match(await shadowText('.ir-head .hint'), /IR, Out, DTD and DNR players can move to IR\./);

  const before = sleeper.mutations.length;
  await page.locator(panel(`[data-spot="b:${benchId}"]`)).click();
  await page.locator(panel('.card.target button.slot.ir[data-spot="re:0"]')).click();
  await page.locator(panel('.notice.ok')).waitFor();
  assert.match(await shadowText('.notice.ok'), / to IR$/);
  const benchMoves = sleeper.mutations.slice(before);
  assert.equal(benchMoves.length, 1, 'bench to IR only saves IR');
  assert.match(benchMoves[0].query, new RegExp(`roster_update_reserve\\(league_id: "${LEAGUE}", roster_id: ${myRoster.roster_id}, reserve: \\["${benchId}"\\]\\)`));
  await page.locator(panel(`[data-spot="r:${benchId}"]`)).waitFor();
  await page.locator(panel('.notice.ok')).waitFor({ state: 'detached', timeout: 5000 });

  const mid = sleeper.mutations.length;
  await page.locator(panel('[data-spot="s:0"]')).click();
  await page.locator(panel('.card.target button.slot.ir[data-spot="re:0"]')).click();
  await page.locator(panel('.notice.ok')).waitFor();
  const starterMoves = sleeper.mutations.slice(mid);
  assert.deepEqual(starterMoves.map((m) => m.query.match(/mutation (\w+)/)[1]), ['update_matchup_leg', 'roster_update_reserve'],
    'the starter leaves the lineup before going on IR');
  assert.match(starterMoves[0].query, /starters: \["0",/);
  await page.locator(panel(`[data-spot="r:${starterId}"]`)).waitFor();
  await page.locator(panel(".ir-head")).evaluate((h) => h.scrollIntoView());
  await page.screenshot({ path: `${OUT}ir-moved.png` });

  await page.reload();
  await page.locator(panel(`[data-spot="r:${starterId}"]`)).waitFor({ timeout: 30000 });
  assert.ok(await page.locator(panel(`[data-spot="r:${benchId}"]`)).count(), 'both stay on IR after reload');
  sleeper.injured = new Set();
  documentBody = LOGGED_OUT;
});

test('player card: clicking a player opens bio, game logs, career, news and depth chart', async () => {
  documentBody = LOGGED_OUT;
  await page.goto(TEAM_URL);
  const name = page.locator(panel('.card button.name')).first();
  await name.waitFor({ timeout: 30000 });
  const playerName = await name.textContent();
  await name.click();
  await page.locator(dialog('.pc')).waitFor();
  // Loading must not move what's on screen. The card re-renders from fresh HTML, which the
  // layout-shift API can't see, so track where the Career heading sits whenever it's visible.
  await page.evaluate(() => {
    // Moves where the heading was on screen before or after: [from, to] in px from the top of the column.
    window.__careerMoves = [];
    let last = null;
    const tick = () => {
      const root = document.querySelector('#sleeper-nba-dialog')?.shadowRoot;
      const main = root?.querySelector('.pc-main');
      const head = [...(root?.querySelectorAll('.pc-main h2') || [])].find((h) => h.textContent === 'Career');
      if (main && head) {
        const top = Math.round(head.getBoundingClientRect().top - main.getBoundingClientRect().top);
        const visible = (y) => y < main.clientHeight;
        if (last != null && top !== last && (visible(last) || visible(top))) window.__careerMoves.push([last, top]);
        last = top;
      }
      if (window.__careerMoves) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  assert.equal(await page.locator(dialog('h2.pc-name')).textContent(), playerName);
  await page.locator(dialog('.pc-item-value')).first().filter({ hasText: /^\d+$/ }).waitFor({ timeout: 15000 });
  const bio = await page.locator(dialog('.pc-bio')).textContent();
  assert.match(bio, /Age\s*\d+\s*Height\s*\d'\d+"\s*Weight\s*\d+\s*lbs\s*Exp\s*\d+\s*College/);
  assert.match(await page.locator(dialog('.pc-number')).textContent(), /[A-Z0-9 ]+( #\d+)?/);

  // This season: upcoming games with projections; last season: played games, heat-shaded.
  await page.locator(dialog('.pc-table.log tbody tr td.opp')).first().waitFor({ timeout: 15000 });
  assert.match(await page.locator(dialog('.pc-table.log tbody tr')).first().textContent(), /\d+\.\d\d/);
  const tabs = page.locator(dialog('.pc-seasons button'));
  await page.waitForFunction(() => document.querySelector('#sleeper-nba-dialog').shadowRoot.querySelectorAll('.pc-seasons button').length > 1, null, { timeout: 15000 });
  await tabs.nth(1).click();
  await page.locator(dialog('.pc-seasons button.on')).filter({ hasText: await tabs.nth(1).textContent() }).waitFor();
  await page.locator(dialog('.pc-table.log td[style*="background"]')).first().waitFor({ timeout: 15000 });
  assert.ok(await page.locator(dialog('.pc-table.career tbody tr td.fpts')).count() >= 1, 'career has at least one season');
  const moves = await page.evaluate(() => { const m = window.__careerMoves; window.__careerMoves = null; return m; });
  assert.deepEqual(moves, [], 'nothing on screen moves while game logs load');

  await page.locator(dialog('.pc-news h3')).first().waitFor({ timeout: 15000 });
  await page.locator(dialog('.pc-depth-row li.me')).waitFor({ timeout: 15000 });
  assert.equal(await page.locator(dialog('.pc-depth-row li.me')).textContent(), playerName);
  assert.match(await page.locator(dialog('.pc-main')).textContent(), /Transaction History\s*Log in to Sleeper/);
  await page.screenshot({ path: `${OUT}player-card.png` });
  await page.locator(dialog('.pc-main')).evaluate((m) => { m.scrollTop = m.scrollHeight; });
  await page.screenshot({ path: `${OUT}player-card-bottom.png` });

  await page.keyboard.press('Escape');
  await page.locator(dialog('.pc')).waitFor({ state: 'detached' });
});

test('player card: opens from the Players and Trend tabs instead of Sleeper\'s card', async () => {
  documentBody = LOGGED_OUT;
  const [first, second] = await freeAgents(2);
  documentBody = playersTab([{ ...first, status: 'waiver' }, { ...second, status: 'free_agent', trend: true }]);
  await page.goto(PLAYERS_URL);
  await page.waitForFunction((id) => document.documentElement.dataset.snpNbaLeague === id, LEAGUE, { timeout: 30000 });
  for (const p of [first, second]) {
    await page.locator('.player-meta-container, .player-details').filter({ hasText: p.name }).click();
    await page.locator(dialog('h2.pc-name')).filter({ hasText: p.name }).waitFor({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.locator(dialog('.pc')).waitFor({ state: 'detached' });
  }
  assert.equal(await page.evaluate(() => window.__sleeperCards), 0, "Sleeper's own card never opens");
  documentBody = LOGGED_OUT;
});


test('sidebar: from a Matchup tab, an NBA league opens on its Matchup tab', async () => {
  documentBody = leagueNav;
  await page.goto(`https://sleeper.com/leagues/${NFL_LEAGUE}/matchup`);
  await page.locator('[data-sport=nba] .league-title').click();
  assert.equal(new URL(page.url()).pathname, `/leagues/${LEAGUE}/matchup`);
  assert.deepEqual(await page.evaluate(() => [window.__selected, window.__sleeperNav]), [[LEAGUE], []]);
  // Other sports, and other tabs, keep Sleeper's own navigation.
  await page.locator('[data-sport=nfl]').click();
  assert.equal(new URL(page.url()).pathname, `/leagues/${NFL_LEAGUE}`);
  await page.goto(`https://sleeper.com/leagues/${NFL_LEAGUE}/league`);
  await page.locator('[data-sport=nba]').click();
  assert.equal(new URL(page.url()).pathname, `/leagues/${LEAGUE}`);
  assert.deepEqual(await page.evaluate(() => window.__sleeperNav), ['nba']);
  documentBody = LOGGED_OUT;
});

test('optimize lineup: proposes changes, guards green scores, and saves only once applied', async () => {
  documentBody = LOGGED_IN;
  sleeper.rosters = null;
  await startMidWeek();
  const myRoster = await openMyTeam(TEAM_URL);
  const leg = sleeper.legs[1].find((l) => l.roster_id === myRoster.roster_id);
  const league = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}`)).json();
  const util = league.roster_positions.filter((p) => p !== 'BN').indexOf('UTIL');
  const victim = leg.starters[util];
  // Stat points that score exactly `fpts` fantasy points under the league's scoring.
  const statPts = (fpts) => fpts / league.scoring_settings.pts;
  // A bench player with games left after their first (finished) one becomes a must-start.
  const { data } = await (await fetch('https://sleeper.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query scores { scores(sport: "nba", season_type: "regular", season: "2026", week: 1) { game_id metadata } }' }),
  })).json();
  const gamesOf = (team) => data.scores.filter((g) => [g.metadata?.home_team?.team, g.metadata?.away_team?.team].includes(team)).length;
  const players = await (await fetch('https://api.sleeper.app/v1/players/nba')).json();
  const placed = new Set([...leg.starters, ...(myRoster.taxi || []), ...(myRoster.reserve || [])]);
  const bench = myRoster.players.filter((id) => !placed.has(id) && gamesOf(players[id].team) >= 2);
  const star = bench[0];
  // The UTIL starter scored a little in their finished game and is projected nothing after it.
  sleeper.projections = (rows) => rows.map((r) => {
    if (r.player_id === star) return { ...r, stats: { pts: statPts(50) } };
    if (r.player_id === victim) return { ...r, stats: { pts: sleeper.finished.has(r.game_id) ? statPts(3) : 0 } };
    return r;
  });
  await page.reload();
  await page.locator(panel('.taxi-head .hint')).waitFor({ timeout: 30000 });

  // Offered on your own team only.
  await page.locator(panel('button.optimize')).waitFor();
  const other = sleeper.rosters.find((r) => r.roster_id !== myRoster.roster_id);
  await page.locator(panel('select')).selectOption(String(other.roster_id));
  await page.locator(panel('button.optimize')).waitFor({ state: 'detached' });
  await page.locator(panel('select')).selectOption(String(myRoster.roster_id));

  const before = sleeper.mutations.length;
  await page.locator(panel('button.optimize')).click();
  await page.locator(dialog('.op-row')).first().waitFor();
  assert.match(await page.locator(dialog('.op-sum')).textContent(), /Lineup projection\s*Starters' points per game\s*\d+\.\d\d\s*→\s*\d+\.\d\d\s*\+\d+\.\d\d/);
  // The tooltip shows on hover, inside the dialog.
  assert.equal(await page.locator(dialog('.how-tip')).isVisible(), false);
  await page.locator(dialog('.how')).hover();
  assert.match(await page.locator(dialog('.how-tip')).innerText(), /^How it picks:\n1\. Every player gets a number/);
  await page.screenshot({ path: `${OUT}optimize-how.png` });
  await page.mouse.move(0, 0);
  // A small lockable score given up is a soft warning: yellow, and Apply still works.
  const victimRow = page.locator(dialog('.op-row.warning')).filter({ hasText: players[victim].full_name });
  assert.match(await victimRow.textContent(), /Can't lock 3\.00 · \w{3} (vs|@) \w+/);
  assert.equal(await victimRow.locator('.score.red').textContent(), '3.00', 'the score shows in its tier color');
  assert.match(await page.locator(dialog('.warn-banner')).textContent(), new RegExp(`${players[victim].full_name} 3\\.00.* finished games? you could still lock in`));
  assert.equal(await page.locator(dialog('.lose-banner')).count(), 0, 'no hard stop for a red score');
  assert.equal(await page.locator(dialog('[data-action="apply-lineup"]')).isDisabled(), false);
  assert.equal(await page.locator(dialog('.op-row')).filter({ hasText: players[star].full_name }).count(), 1, 'the must-start comes in');
  await page.screenshot({ path: `${OUT}optimize-dialog.png` });

  // A player's card opens over the dialog; closing it comes back to the dialog.
  await page.locator(dialog(`.op-row button.name[data-player="${star}"]`)).click();
  await page.locator(dialog('h2.pc-name')).filter({ hasText: players[star].full_name }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator(dialog('.op-row')).first().isVisible(), true, 'the dialog stays underneath');
  await page.screenshot({ path: `${OUT}optimize-card.png` });
  await page.keyboard.press('Escape');
  await page.locator(dialog('.pc')).waitFor({ state: 'detached' });
  await page.locator(dialog('.op-row')).first().waitFor();

  // Dismissing changes nothing.
  await page.locator(dialog('.op-foot button[data-action="close-modal"]')).click();
  await page.locator(dialog('.modal')).waitFor({ state: 'detached' });
  assert.equal(sleeper.mutations.length, before, 'nothing saved on cancel');

  // Now the UTIL starter's finished game was green (24+) and every bench player is a must-start,
  // the star most of all, so ties among the bench can't leave them out.
  sleeper.projections = (rows) => rows.map((r) => {
    if (r.player_id === star) return { ...r, stats: { pts: statPts(60) } };
    if (bench.includes(r.player_id)) return { ...r, stats: { pts: statPts(50) } };
    if (r.player_id === victim) return { ...r, stats: { pts: sleeper.finished.has(r.game_id) ? statPts(30) : 0 } };
    return r;
  });
  await page.reload();
  await page.locator(panel('button.optimize')).click();
  await page.locator(dialog('.lose-banner')).waitFor();
  assert.match(await page.locator(dialog('.lose-banner')).textContent(), new RegExp(players[victim].full_name));
  // Big games earn scoring bonuses too, so the score is at least what was set.
  const given = Number((await page.locator(dialog('.op-row.losing')).filter({ hasText: players[victim].full_name }).textContent()).match(/Can't lock (\d+\.\d\d)/)[1]);
  assert.ok(given >= 24, `a green score (${given})`);
  const apply = page.locator(dialog('[data-action="apply-lineup"]'));
  assert.match(await apply.textContent(), /^Apply and lose \d+\.\d\d pts$/);
  assert.equal(await apply.isDisabled(), true, 'giving up a green score needs the tick box');
  await page.screenshot({ path: `${OUT}optimize-green.png` });
  await page.locator(dialog('[data-op-ack]')).check();
  await apply.click();
  await page.locator(dialog('.modal')).waitFor({ state: 'detached' });
  await page.locator(panel('.notice.ok')).waitFor();
  const saved = sleeper.mutations.slice(before);
  assert.equal(saved.length, 1, 'one lineup save');
  assert.match(saved[0].query, /mutation update_matchup_leg/);
  assert.deepEqual(saved[0].variables, {}, 'existing locks are left alone');
  const starters = JSON.parse(saved[0].query.match(/starters: (\[[^\]]*\])/)[1]);
  assert.ok(starters.includes(star) && !starters.includes(victim));
  assert.match(await shadowText('.notice.ok'), /^Saved: (\d+ lineup changes|.*to bench)$/);
  await page.screenshot({ path: `${OUT}optimize-saved.png` });

  // Applied again, the lineup is already the best one.
  await page.locator(panel('.notice.ok')).waitFor({ state: 'detached', timeout: 5000 });
  await page.locator(panel('button.optimize')).click();
  assert.match(await page.locator(dialog('.dialog-body')).textContent(), /already your best lineup/);
  await page.keyboard.press('Escape');
  sleeper.projections = null;
  sleeper.midWeek = false;
  documentBody = LOGGED_OUT;
});

test('logged in with a session Sleeper turns down: asks to log back in instead of showing wrong numbers', async () => {
  documentBody = LOGGED_IN;
  sleeper.rejectSession = true;
  await page.goto(MATCHUP_URL);
  await page.locator(panel('.session-expired')).waitFor({ timeout: 30000 });
  assert.match(await page.locator(panel('.session-expired')).innerText(), /Log back in to Sleeper[\s\S]*Log out of Sleeper, log back in, then reload this page\./);
  assert.equal(await page.locator(panel('.mu-head, .card, .team-card')).count(), 0, 'no numbers from the logged-out fallbacks');
  await page.screenshot({ path: `${OUT}session-expired.png` });
  // The API log shows what failed.
  await page.locator(panel('[data-tab="api"]')).click();
  await page.locator(panel('.status.bad'), { hasText: '401' }).first().waitFor();
  await page.locator(panel('[data-tab="page"]')).click();

  // Logging back in gives the page a new token; a refresh then loads normally.
  sleeper.rejectSession = false;
  await page.evaluate((t) => localStorage.setItem('token', `${t}-fresh`), FAKE_TOKEN);
  await page.locator(panel('[data-action="refresh"]')).click();
  await page.locator(panel('.mu-head')).waitFor({ timeout: 30000 });
  assert.equal(await page.locator(panel('.session-expired')).count(), 0);
  documentBody = LOGGED_OUT;
});

const corner = (sel = '') => `#sleeper-nba-scoring ${sel}`;

test('what-if scoring: try other values from the corner on the Team, Matchup and player card, then switch back', async () => {
  documentBody = LOGGED_IN;
  sleeper.rosters = null;
  await startMidWeek();
  // Hidden by default: admin tools only show once a URL turns them on.
  await openMyTeam(TEAM_URL);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(corner('.wi-dock')).count(), 0, 'no Scoring control without ?snp-admin=1');
  await openMyTeam(`${TEAM_URL}?snp-admin=1`);
  // Sleeper's router drops the query string as you move around; the choice sticks anyway.
  await page.evaluate(() => history.replaceState({}, '', location.pathname));
  const league = await (await fetch(`https://api.sleeper.app/v1/league/${LEAGUE}`)).json();
  const pts = league.scoring_settings.pts;
  const cells = () => page.locator(panel('.card .cell .v')).allTextContents();
  const before = await cells();
  assert.match(await page.locator(panel('.team-card .score .sub')).textContent(), /proj 157\.23/, "Sleeper's own projection");

  // Collapsed: League is on, and What-if waits for a change.
  await page.locator(corner('.wi-dock')).waitFor();
  assert.equal(await page.locator(corner('[data-wi="league"]')).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator(corner('[data-wi="whatif"]')).isDisabled(), true);

  // Typing applies as you go and keeps the field focused.
  await page.locator(corner('[data-wi="toggle-open"]')).click();
  const input = page.locator(corner('input[data-wi-key="pts"]'));
  assert.equal(await input.inputValue(), String(pts));
  await input.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(String(pts * 3), { delay: 30 });
  assert.equal(await input.evaluate((el) => el.getRootNode().activeElement === el), true, 'still typing in the same field');
  assert.equal(await input.inputValue(), String(pts * 3));
  await page.locator(corner('.wi-row.changed .wi-was')).filter({ hasText: `League ${pts}` }).waitFor();
  await page.locator(panel('.app.whatif')).waitFor();
  assert.match(await page.locator(panel('.whatif-banner')).textContent(), new RegExp(`Points Scored ${pts} → ${pts * 3}`));
  assert.notDeepEqual(await cells(), before, 'projections rescored');
  assert.doesNotMatch(await page.locator(panel('.team-card .score .sub')).textContent(), /157\.23/, "Sleeper's league-scored total is set aside");
  assert.equal(await page.locator(panel('button.optimize')).isDisabled(), true, 'Optimize uses league scoring');
  await page.screenshot({ path: `${OUT}whatif-editor.png` });

  // Like a tooltip, a click elsewhere closes the editor; the switch stays on What-if.
  await page.locator(panel('.team-card')).click({ position: { x: 5, y: 5 } });
  await page.locator(corner('.wi-pop')).waitFor({ state: 'detached' });
  assert.equal(await page.locator(corner('[data-wi="whatif"]')).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator(corner('[data-wi="whatif"] .count')).textContent(), '1');
  await page.screenshot({ path: `${OUT}whatif-on.png` });

  // The player card is rescored too, with the switch still reachable over it.
  await page.locator(panel('.card button.name')).first().click();
  await page.locator(dialog('.pc.whatif .whatif-banner')).waitFor({ timeout: 30000 });
  await page.locator(dialog('.pc-table.log tbody tr:not(.skeleton)')).first().waitFor({ timeout: 30000 });
  // Its game log shows the league's Fpts and the what-if adminFPTS side by side.
  assert.deepEqual(await page.locator(dialog('.pc-table.log thead tr:not(.group) th')).allTextContents(),
    ['Wk', 'Date', 'Opp', 'Proj', 'Fpts', 'adminFPTS', 'Min', 'Pts', 'Reb', 'Ast', 'Stl', 'Blk', 'To', 'Fg', '3pt', 'Ft']);
  const played = page.locator(dialog('.pc-table.log tbody tr')).filter({ has: page.locator('td.fpts.admin:not(:text("-"))') }).first();
  if (await played.count()) {
    const [fpts, adminFpts] = (await played.locator('td.fpts').allTextContents()).map(Number);
    assert.ok(adminFpts > fpts, `adminFPTS (${adminFpts}) beats Fpts (${fpts}) with points worth more`);
  }
  const box = await page.locator(corner('.wi-dock')).boundingBox();
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2]), 'sleeper-nba-scoring');
  await page.screenshot({ path: `${OUT}whatif-card.png` });
  await page.keyboard.press('Escape');
  await page.locator(dialog('.pc')).waitFor({ state: 'detached' });

  // Remembered across reloads and pages (no ?snp-admin here); the Matchup tab sets aside Sleeper's totals and Lock-In.
  await page.goto(MATCHUP_URL);
  await page.locator(panel('.app.whatif .mu-head')).waitFor({ timeout: 30000 });
  assert.doesNotMatch(await page.locator(panel('.mu-head')).textContent(), /157\.23/);
  assert.equal(await page.locator(panel('[data-lock]')).count(), 0, 'no locking real points from what-if numbers');
  await page.screenshot({ path: `${OUT}whatif-matchup.png` });

  // Back to the league's scoring from the switch, and back again.
  await page.locator(corner('[data-wi="league"]')).click();
  await page.locator(panel('.app.whatif')).waitFor({ state: 'detached' });
  assert.match(await page.locator(panel('.mu-head')).textContent(), /157\.23/);
  await page.locator(corner('[data-wi="whatif"]')).click();
  await page.locator(panel('.app.whatif')).waitFor();

  // Reset puts every value back and turns what-if off.
  await page.locator(corner('[data-wi="toggle-open"]')).click();
  await page.locator(corner('[data-wi="reset"]')).click();
  await page.locator(panel('.app.whatif')).waitFor({ state: 'detached' });
  assert.equal(await page.locator(corner('input[data-wi-key="pts"]')).inputValue(), String(pts));
  assert.equal(await page.locator(corner('.wi-row.changed')).count(), 0);
  await page.keyboard.press('Escape');
  await page.locator(corner('.wi-pop')).waitFor({ state: 'detached' });
  assert.equal(await page.locator(corner('[data-wi="whatif"]')).isDisabled(), true);
  sleeper.midWeek = false;
  documentBody = LOGGED_OUT;
});

test('what-if scoring: the Players tab gets sortable adminFPTS and adminDelta columns beside FPTS', async () => {
  documentBody = playersTable([
    { id: 'scorer', pos: 'PG', owner: 'OuiThePeople the longest name', stats: { fpts_proj: 32, pts: 30, reb: 2, gp: 1 } },
    { id: 'guard', pos: 'PG', stats: { fpts_proj: 31, pts: 29, reb: 2, gp: 1 } },
    { id: 'rebounder', pos: 'C', stats: { fpts_proj: 30, pts: 10, reb: 20, gp: 1 } },
    // Two games: Sleeper stores totals and shows them per game (31.0), but sorts on the totals.
    { id: 'veteran', pos: 'SF', stats: { fpts_proj: 62, pts: 60, reb: 2, gp: 2 } },
  ]);
  await page.goto(`${PLAYERS_URL}?snp-admin=1`);
  const labels = () => page.locator('.stat-key-header .label').allTextContents();
  const order = () => page.locator('.player-list-item').evaluateAll((rows) => rows.map((r) => r.dataset.id));
  // FPTS, admin FPTS, admin Delta, then PTS and REB.
  const cells = (id) => page.locator(`.player-list-item[data-id="${id}"] .cell`).evaluateAll((els) => els.map((el) => el.querySelector('.snp-delta, .snp-admin-value')?.textContent ?? el.textContent))
    .then((all) => [...all.slice(0, 3), all[4], all[6]]);
  const badge = (id) => page.locator(`.player-list-item[data-id="${id}"] .snp-delta`);
  const shown = async (id, text) => page.waitForFunction(([i, t]) => document.querySelector(`.player-list-item[data-id="${i}"] .snp-delta`)?.textContent === t, [id, text]);
  await page.waitForFunction(() => [...document.querySelectorAll('.stat-key-header .label')].some((l) => l.textContent === 'admin Delta'), null, { timeout: 30000 });
  assert.deepEqual(await labels(), ['FPTS', 'admin FPTS', 'admin Delta', 'MIN', 'PTS', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO'], 'right after FPTS');
  await shown('rebounder', '0');
  assert.deepEqual(await cells('rebounder'), ['30.0', '30.0', '0', '10.0', '20.0'], 'matches FPTS until a value changes, so nobody moves');
  assert.deepEqual(await cells('veteran'), ['31.0', '31.0', '0', '30.0', '1.0'], 'per game, like every column');
  assert.equal(await page.locator('.stat-key-header .label span').nth(1).evaluate((el) => getComputedStyle(el).textTransform), 'none', 'reads as named');
  // Every row, owner line or not, puts each value where Sleeper's table does
  // (centered under its left-aligned header, 17px left of the header's box),
  // and all 11 columns fit in Sleeper's 796px row.
  const layout = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.stat-key-header .label')].map((l) => l.getBoundingClientRect());
    return [...document.querySelectorAll('.player-list-item')].map((row) => {
      const cellBoxes = [...row.querySelectorAll('.cell')].map((c) => c.getBoundingClientRect());
      return { offsets: [...new Set(labels.map((l, i) => Math.round(cellBoxes[i].x - l.x)))], overflow: Math.round(cellBoxes.at(-1).right - row.getBoundingClientRect().right) };
    });
  });
  for (const row of layout) {
    assert.deepEqual(row.offsets, [-17], 'columns line up');
    assert.ok(row.overflow <= 0, `the last column fits (${row.overflow}px over)`);
  }

  // The Scoring control is here too; changing a value rescores and reranks.
  await page.locator(corner('[data-wi="toggle-open"]')).click();
  const reb = page.locator(corner('input[data-wi-key="reb"]'));
  await reb.fill(String((await reb.inputValue()) * 1 + 2));
  await shown('rebounder', '+3');
  assert.deepEqual(await cells('rebounder'), ['30.0', '70.0', '+3', '10.0', '20.0']);
  assert.deepEqual(await cells('scorer'), ['32.0', '36.0', '−1', '30.0', '2.0']);
  assert.deepEqual(await cells('veteran'), ['31.0', '33.0', '−2', '30.0', '1.0'], 'ranked per game, not on its two-game total');
  // Both places show under the badge, to check a shift at a glance.
  assert.equal(await page.locator('.player-list-item[data-id="rebounder"] .snp-places').textContent(), '#4→#1');
  assert.equal(await page.locator('.player-list-item[data-id="veteran"] .snp-places').textContent(), '#2→#4');
  assert.equal(await page.locator('.player-list-item[data-id="scorer"] .snp-places').textContent(), '#1→#2');
  assert.match(await page.locator('.player-list-item[data-id="scorer"] [data-snp-delta]').getAttribute('title'), /Rank by FPTS 1, by adminFPTS 2/);
  const color = await page.locator('.player-list-item[data-id="rebounder"] .cell').nth(1).evaluate((el) => getComputedStyle(el).color);
  assert.equal(color, 'rgb(182, 156, 255)', 'adminFPTS in the what-if color once a value changes');
  // Green up, red down, deeper for the bigger move.
  assert.equal(await badge('rebounder').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(52, 168, 83, 0.9)');
  assert.equal(await badge('scorer').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(214, 69, 80, 0.43)');
  await page.keyboard.press('Escape');

  // All three columns sort from their headers, with a thin bar under the sorted one.
  const sortedLabel = () => page.locator('.stat-key-header .label').evaluateAll((els) => els.filter((el) => el.hasAttribute('data-snp-sorted')).map((el) => el.textContent));
  assert.deepEqual(await order(), ['veteran', 'scorer', 'guard', 'rebounder'], "sorted by FPTS (Sleeper's own column sorts on totals)");
  assert.deepEqual(await sortedLabel(), ['FPTS']);
  assert.equal(await page.locator('.stat-key-header .label[data-snp-sorted]').evaluate((el) => getComputedStyle(el, '::after').backgroundColor), 'rgb(0, 206, 184)');
  await page.locator('.stat-key-header .label', { hasText: 'admin FPTS' }).click();
  assert.deepEqual(await order(), ['rebounder', 'scorer', 'guard', 'veteran'], 'sorted by adminFPTS per game, as shown');
  await page.waitForFunction(() => document.querySelector('.stat-key-header .label[data-snp-sorted]')?.textContent === 'admin FPTS');
  await page.locator('.stat-key-header .label', { hasText: 'admin Delta' }).click();
  assert.deepEqual(await order(), ['rebounder', 'scorer', 'guard', 'veteran'], 'sorted by adminDelta, biggest riser first');
  await shown('rebounder', '+3');
  await page.waitForFunction(() => document.querySelector('.stat-key-header .label[data-snp-sorted]')?.textContent === 'admin Delta');
  await page.screenshot({ path: `${OUT}whatif-players.png` });
  await page.locator('.stat-key-header .label', { hasText: /^FPTS$/ }).click();
  assert.deepEqual(await order(), ['veteran', 'scorer', 'guard', 'rebounder']);

  // Ranks are within the list on screen: among guards only, nobody moves.
  await page.locator('.filters [data-pos="PG"]').click();
  await shown('scorer', '0');
  assert.equal(await badge('guard').textContent(), '0');
  await page.locator('.filters [data-pos="ALL"]').click();
  await shown('scorer', '−1');

  // Reset brings adminFPTS back to FPTS.
  await page.locator(corner('[data-wi="toggle-open"]')).click();
  await page.locator(corner('[data-wi="reset"]')).click();
  await shown('rebounder', '0');
  assert.deepEqual(await cells('rebounder'), ['30.0', '30.0', '0', '10.0', '20.0']);
  await page.keyboard.press('Escape');

  // ?snp-admin=0 (here pushed the way Sleeper's router moves) takes the columns and the control away, and it sticks.
  await page.evaluate(() => history.pushState({}, '', `${location.pathname}?snp-admin=0`));
  await page.waitForFunction(() => document.querySelectorAll('.stat-key-header .label').length === 9);
  assert.deepEqual(await labels(), ['FPTS', 'MIN', 'PTS', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO']);
  await page.locator(corner('.wi-dock')).waitFor({ state: 'detached' });
  await page.goto(PLAYERS_URL);
  await page.waitForTimeout(1500);
  assert.equal((await labels()).length, 9, 'still off after a reload');
  assert.equal(await page.locator(corner('.wi-dock')).count(), 0);
  documentBody = LOGGED_OUT;
});

const nflDialog = (sel = '') => `#sleeper-nfl-dialog ${sel}`;
test('NFL optimize lineup: an OPTIMIZE button beside WAIVER and TRADE proposes and saves through Sleeper', async () => {
  documentBody = nflTeamTab();
  await page.goto(NFL_TEAM_URL);
  const button = page.locator('.user-tab-menu .actions > #snp-optimize');
  await button.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.user-tab-menu .actions > .btn-container').first().getAttribute('id'), 'snp-optimize', 'first, left of WAIVER');
  assert.equal(await button.locator('.btn-text').textContent(), 'OPTIMIZE');
  assert.equal(await page.locator('#sleeper-nba-panel').count(), 0, 'no NBA panel on an NFL league');
  await page.locator('.user-tab-menu').screenshot({ path: `${OUT}nfl-button.png` });

  await button.click();
  await page.locator(nflDialog('.op-row')).first().waitFor();
  assert.match(await page.locator(nflDialog('.op-sum')).textContent(), /51\.00\s*→\s*68\.00\s*\+17\.00/);
  const rows = await page.locator(nflDialog('.op-row')).evaluateAll((els) => els.map((el) => el.querySelector('.dp-name b').textContent));
  // Alpha WR keeping WR with Gamma WR at FLEX adds up the same as swapping them, so nobody else moves.
  assert.deepEqual(rows, ['Gamma WR', 'Beta QB', 'Beta RB', 'Beta WR']);
  // Questionable can start, highlighted; Out and bye-week players don't; kicked-off players stay put.
  const questionable = page.locator(nflDialog('.op-row.watch')).filter({ hasText: 'Beta QB' });
  assert.equal(await questionable.locator('.nfl-inj.watch').textContent(), 'Q');
  assert.match(await page.locator(nflDialog('.warn-banner')).textContent(), /Beta QB is Questionable/);
  assert.match(await page.locator(nflDialog('.op-fixed')).textContent(), /Early RB \(game started\)/);
  assert.equal(await page.locator(nflDialog('.lose-banner, [data-op-ack]')).count(), 0, 'no warnings to confirm');
  await page.locator(nflDialog('.how')).hover();
  assert.match(await page.locator(nflDialog('.how-tip')).innerText(), /^How it picks:\n1\. Every player gets a number: their projected points/);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${OUT}nfl-dialog.png` });

  // Cancel saves nothing.
  await page.locator(nflDialog('.op-foot button[data-action="close-modal"]')).click();
  await page.locator(nflDialog('.modal')).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__nflSaves.length), 0);

  // A refused save keeps the dialog open with Sleeper's error.
  await page.evaluate(() => { window.__nflFail = 'Player is locked'; });
  await button.click();
  await page.locator(nflDialog('[data-action="apply-lineup"]')).click();
  assert.match(await page.locator(nflDialog('.dialog-errors')).textContent(), /Player is locked/);
  await page.evaluate(() => { window.__nflFail = null; });

  await page.locator(nflDialog('[data-action="apply-lineup"]')).click();
  await page.locator(nflDialog('.modal')).waitFor({ state: 'detached' });
  assert.match(await page.locator(nflDialog('.notice.ok')).textContent(), /^Saved: 4 lineup changes$/);
  const saves = await page.evaluate(() => window.__nflSaves);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1], [NFL_LEAGUE, 4, 7, 7, ['qbA', 'rbPlayed', 'wrA', 'wrC', 'qbB']], "Sleeper's own updateMatchupLeg, in season");
  await page.screenshot({ path: `${OUT}nfl-saved.png` });

  // The saved lineup is the best one now; and the button is only for your own team.
  await button.click();
  assert.match(await page.locator(nflDialog('.dialog-body')).textContent(), /already your best lineup for week 7/);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__nflTeam.memoizedProps.isTeamOwner = false; });
  await button.waitFor({ state: 'detached' });
  documentBody = LOGGED_OUT;
});
