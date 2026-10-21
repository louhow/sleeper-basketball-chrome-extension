import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { model, scoring } = loadSnp();
const plain = (x) => JSON.parse(JSON.stringify(x));

const score = (gameId, date, home, away, extra = {}) =>
  ({ game_id: gameId, date, start_time: Date.parse(`${date}T23:00:00Z`), status: 'pre_game', metadata: { home_team: { team: home }, away_team: { team: away } }, ...extra });

test('week runs Monday to Sunday around its first game', () => {
  const days = model.weekDays([score('a', '2026-10-21', 'LAL', 'GSW'), score('b', '2026-10-20', 'DET', 'BOS')]);
  assert.deepEqual(plain(days), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(plain(model.weekDays([score('c', '2026-10-25', 'UTA', 'LAL')])).at(0), '2026-10-19', 'a Sunday belongs to the week before');
  assert.deepEqual(plain(model.weekDays([])), []);
});

test('player days pair each game with home/away, projection and actual points', () => {
  const games = [score('g1', '2026-10-21', 'LAL', 'GSW'), score('g2', '2026-10-25', 'UTA', 'LAL', { status: 'complete' })];
  const settings = { pts: 1 };
  const week = {
    days: model.weekDays(games),
    gamesByTeam: model.gamesByTeam(games),
    proj: model.pointsByGame([{ player_id: '1970', game_id: 'g1', stats: { pts: 30.79 } }, { player_id: '1970', game_id: 'g2', stats: { pts: 39.83 } }], settings, scoring.scoreStats),
    actual: model.pointsByGame([{ player_id: '1970', game_id: 'g2', stats: { pts: 41 } }], settings, scoring.scoreStats),
  };
  const days = model.playerDays(week, 'LAL', '1970');
  assert.equal(days.length, 7);
  assert.deepEqual(plain(days.filter((d) => d.game).map((d) => [d.date, d.home ? 'vs' : '@', d.opponent, d.proj, d.actual ?? null])),
    [['2026-10-21', 'vs', 'GSW', 30.79, null], ['2026-10-25', '@', 'UTA', 39.83, 41]]);
  assert.equal(model.lockInDefault(days), 39.83, 'unlocked players score their final game');
  assert.equal(model.lockInDefault(model.playerDays(week, 'NYK', 'x')), null, 'no games, no projection');
  assert.equal(model.lockInDefault(model.playerDays(week, 'LAL', 'unprojected')), null, 'unprojected final game, no projection');
});

test('owned picks follow trades in both directions', () => {
  const picks = model.ownedPicks({
    rosterId: 10,
    rosterIds: [8, 9, 10],
    seasons: ['2027', '2028'],
    rounds: 2,
    traded: [
      { season: '2027', round: 1, roster_id: 10, owner_id: 9 },
      { season: '2027', round: 2, roster_id: 8, owner_id: 10 },
      { season: '2028', round: 1, roster_id: 10, owner_id: 8 },
    ],
  });
  assert.deepEqual(plain(picks), [
    { season: '2027', round: 2, original: 8 },
    { season: '2027', round: 2, original: 10 },
    { season: '2028', round: 2, original: 10 },
  ]);
});

const lineup = () => ({
  slots: ['PG', 'G', 'F', 'C', 'UTIL'],
  starters: ['pg', 'sg', 'sf', '0', 'c2'],
  bench: ['pf', 'c', 'pgsg'],
  players: {
    pg: { positions: ['PG'] },
    sg: { positions: ['SG'] },
    sf: { positions: ['SF'] },
    c2: { positions: ['C'] },
    pf: { positions: ['PF'] },
    c: { positions: ['C', 'PF'] },
    pgsg: { positions: ['PG', 'SG'] },
  },
});

test('swap targets respect slot eligibility in both directions', () => {
  const l = lineup();
  // The PG could slide to G or UTIL, but neither occupant can play PG in return.
  assert.deepEqual(plain(model.swapTargets('s:0', l)), ['b:pgsg']);
  // The G-slot SG could go to UTIL, but the center there can't play G.
  assert.deepEqual(plain(model.swapTargets('s:1', l)), ['b:pgsg']);
  // Empty C slot takes any bench player who can play C; UTIL's C can slide over too.
  assert.deepEqual(plain(model.swapTargets('s:3', l)), ['s:4', 'b:c']);
  // A bench big can go to F, C (empty) or UTIL, never another bench spot.
  assert.deepEqual(plain(model.swapTargets('b:c', l)), ['s:2', 's:3', 's:4']);
});

test('applying a swap moves players between slots and the bench', () => {
  const l = lineup();
  const starters = (from, to) => plain(model.applyMove(from, to, l).starters);
  assert.deepEqual(starters('s:0', 's:1'), ['sg', 'pg', 'sf', '0', 'c2']);
  assert.deepEqual(starters('b:c', 's:3'), ['pg', 'sg', 'sf', 'c', 'c2'], 'bench player fills an empty slot');
  assert.deepEqual(starters('s:2', 'b:pf'), ['pg', 'sg', 'pf', '0', 'c2'], 'benched starter just drops out');
});

const day = (id, date, status, start, extra = {}) =>
  ({ date, game: { id, date, status, start: Date.parse(start) }, opponent: 'GSW', home: true, proj: 30, ...extra });
const NOW = Date.parse('2026-10-22T12:00:00Z');

test('lock-in: a finished game is lockable until the next game starts', () => {
  const days = [
    day('g1', '2026-10-21', 'complete', '2026-10-21T23:00:00Z', { actual: 34.5 }),
    day('g2', '2026-10-23', 'pre_game', '2026-10-23T23:00:00Z'),
  ];
  const st = model.lockState(days, undefined, NOW);
  assert.equal(st.lockable, true);
  assert.equal(st.current.game.id, 'g1');
  assert.equal(st.counted, null, 'nothing counts yet');
  assert.equal(st.yetToPlay, true);
  const tipped = model.lockState(days, undefined, Date.parse('2026-10-23T23:05:00Z'));
  assert.equal(tipped.lockable, false, 'window closes at the next tip-off');
  assert.equal(tipped.current.game.id, 'g2');
});

test('lock-in: a locked game counts and is final; otherwise the last game counts', () => {
  const days = [
    day('g1', '2026-10-21', 'complete', '2026-10-21T23:00:00Z', { actual: 34.5 }),
    day('g2', '2026-10-23', 'complete', '2026-10-23T23:00:00Z', { actual: 12 }),
  ];
  const locked = model.lockState(days, 'g1', NOW);
  assert.deepEqual([locked.locked.game.id, locked.points, locked.lockable, locked.yetToPlay], ['g1', 34.5, false, false]);
  const unlocked = model.lockState(days, undefined, NOW);
  assert.deepEqual([unlocked.counted.game.id, unlocked.points], ['g2', 12]);
  assert.equal(model.lockState(days, { game_id: 'g1' }, NOW).locked.game.id, 'g1', 'object-shaped locks work too');
  assert.equal(model.lockState([day('g3', '2026-10-24', 'pre_game', '2026-10-24T23:00:00Z')], undefined, NOW).lockable, false,
    'nothing to lock before the first game ends');
});

test("win probability matches Sleeper's (37% vs 63% at 157.23 vs 181.21)", () => {
  const [a, b] = model.winProbability(0, 157.23, 0, 181.21);
  assert.equal(Math.round(a * 100), 37);
  assert.equal(Math.round(b * 100), 63);
  assert.deepEqual(plain(model.winProbability(120, 120, 100, 100)), [1, 0], 'final scores decide it');
  const [lo] = model.winProbability(0, 50, 0, 400);
  assert.equal(lo, 0.01, 'clamped to 1-99%');
});

test('standings ranks use roster_standings, else record then waiver order', () => {
  const rosters = [
    { roster_id: 1, settings: { wins: 0, waiver_position: 14 } },
    { roster_id: 10, settings: { wins: 0, waiver_position: 3 } },
    { roster_id: 5, settings: { wins: 1, waiver_position: 7 } },
  ];
  assert.deepEqual(plain(model.standingsRanks(rosters, [])), { 5: 1, 10: 2, 1: 3 });
  assert.deepEqual(plain(model.standingsRanks(rosters, [{ roster_id: 1, rank: 1 }])), { 1: 1 });
});

// Taxi: league allows non-rookies with up to 2 years; roster is full with 1 open taxi slot.
const taxiLineup = (overrides = {}) => ({
  ...lineup(),
  bench: ['rookie', 'vet'],
  taxi: ['kid'],
  taxiEditable: true,
  taxiOpen: true,
  taxiRoom: 1,
  benchRoom: 0,
  settings: { taxi_slots: 2, taxi_years: 2, taxi_allow_vets: 1, taxi_deadline: 4 },
  players: {
    ...lineup().players,
    pg: { positions: ['PG'], years_exp: 1 },
    rookie: { positions: ['SF'], years_exp: 0 },
    vet: { positions: ['C'], years_exp: 9 },
    kid: { positions: ['PG'], years_exp: 2 },
  },
  ...overrides,
});

test('taxi eligibility follows experience settings', () => {
  const s = { taxi_years: 2, taxi_allow_vets: 1 };
  assert.equal(model.taxiEligible({ years_exp: 2 }, s), true, 'up to and including taxi_years');
  assert.equal(model.taxiEligible({ years_exp: 3 }, s), false);
  assert.equal(model.taxiEligible({ years_exp: 1 }, { ...s, taxi_allow_vets: 0 }), false, 'rookies only');
  assert.equal(model.taxiEligible({ years_exp: 0 }, { ...s, taxi_allow_vets: 0 }), true);
  assert.equal(model.taxiEligible({ years_exp: 12 }, { taxi_years: 0, taxi_allow_vets: 1 }), true, '0 = no limit');
});

test('taxi window: open until the deadline, then one-way', () => {
  const s = { taxi_deadline: 4 };
  assert.equal(model.taxiOpen(s, 'regular', 1, false), true, 'week 1 before tip-off');
  assert.equal(model.taxiOpen(s, 'regular', 1, true), false, 'locked once week 1 starts');
  assert.equal(model.taxiOpen(s, 'regular', 2, false), false);
  assert.equal(model.taxiOpen(s, 'off', 1, true), true, 'offseason');
  assert.equal(model.taxiOpen({ taxi_deadline: 2 }, 'pre', 2, true), true, 'through preseason week 2');
  assert.equal(model.taxiOpen({ taxi_deadline: 2 }, 'pre', 3, false), false);
  assert.equal(model.taxiOpen({ taxi_deadline: 0 }, 'regular', 9, true), true, 'no deadline');
});

test('taxi moves while open: eligible players go on, displaced taxi players come off', () => {
  const l = taxiLineup();
  assert.deepEqual(plain(model.swapTargets('b:rookie', l)), ['s:2', 's:4', 't:kid', 'te:0'], 'lineup swaps, plus taxi for an eligible player');
  assert.deepEqual(plain(model.swapTargets('b:vet', l)), ['s:3', 's:4'], 'lineup moves only: a 9-year vet is too experienced for taxi');
  assert.deepEqual(plain(model.swapTargets('t:kid', l)), ['s:0', 'b:rookie'],
    'taxi player trades with taxi-eligible starters whose slot it fits, or taxi-eligible bench players');
  assert.deepEqual(plain(model.swapTargets('te:0', l)), ['s:0', 'b:rookie'], 'an open slot takes any eligible player');
  assert.deepEqual(plain(model.applyMove('b:rookie', 't:kid', l)), { starters: l.starters, taxi: ['rookie'], reserve: [] });
  assert.deepEqual(plain(model.applyMove('s:0', 'te:0', l)), { starters: ['0', 'sg', 'sf', '0', 'c2'], taxi: ['kid', 'pg'], reserve: [] });
  assert.deepEqual(plain(model.applyMove('t:kid', 's:0', l)), { starters: ['kid', 'sg', 'sf', '0', 'c2'], taxi: ['pg'], reserve: [] });
});

test('taxi moves after the deadline: only off taxi, into an open bench spot', () => {
  const full = taxiLineup({ taxiOpen: false });
  assert.deepEqual(plain(model.swapTargets('t:kid', full)), [], 'roster full: nowhere to go');
  assert.deepEqual(plain(model.swapTargets('b:rookie', full)), ['s:2', 's:4'], 'lineup swaps still work, nothing moves onto taxi');
  const room = taxiLineup({ taxiOpen: false, benchRoom: 1 });
  assert.deepEqual(plain(model.swapTargets('t:kid', room)), ['be:0']);
  assert.deepEqual(plain(model.applyMove('t:kid', 'be:0', room)), { starters: room.starters, taxi: [], reserve: [] });
});

test('describeMove names where each moved player ends up', () => {
  const l = taxiLineup();
  const moves = (from, to) => plain(model.describeMove(l, model.applyMove(from, to, l)));
  assert.deepEqual(moves('b:rookie', 't:kid'), [{ id: 'kid', to: 'bench' }, { id: 'rookie', to: 'taxi' }]);
  assert.deepEqual(moves('t:kid', 's:0'), [{ id: 'pg', to: 'taxi' }, { id: 'kid', to: 'PG' }]);
  assert.deepEqual(moves('s:0', 's:1'), [{ id: 'pg', to: 'G' }, { id: 'sg', to: 'PG' }]);
});

// Starters pg, sg, sf, (empty), c2; bench: an Out center and a healthy guard; IR: one hurt player, one open slot.
const irLineup = (overrides = {}) => ({
  ...lineup(),
  bench: ['out', 'fine'],
  reserve: ['hurt'],
  reserveEditable: true,
  reserveRoom: 1,
  benchRoom: 0,
  settings: { reserve_slots: 2, reserve_allow_out: 1, reserve_allow_dtd: 1 },
  players: {
    ...lineup().players,
    pg: { positions: ['PG'], injury: 'Out' },
    out: { positions: ['C'], injury: 'Out' },
    fine: { positions: ['PG'] },
    hurt: { positions: ['PG', 'SG'], injury: 'IR' },
  },
  ...overrides,
});

test('IR eligibility: IR and PUP always, other statuses when the league allows them', () => {
  const settings = { reserve_allow_out: 1, reserve_allow_dtd: 1 };
  assert.equal(model.reserveEligible({ injury: 'Out' }, settings), true);
  assert.equal(model.reserveEligible({ injury: 'DTD' }, settings), true);
  assert.equal(model.reserveEligible({ injury: 'IR' }, {}), true);
  assert.equal(model.reserveEligible({ injury: 'Questionable' }, settings), false);
  assert.equal(model.reserveEligible({ injury: 'Sus' }, settings), false);
  assert.equal(model.reserveEligible({}, settings), false);
});

test('IR moves: eligible players go onto IR, and IR players come off into their spot', () => {
  const l = irLineup();
  assert.ok(model.swapTargets('b:out', l).includes('re:0'), 'an Out bench player can fill the open IR slot');
  assert.ok(model.swapTargets('b:out', l).includes('r:hurt'), 'or trade places with the IR player');
  assert.ok(model.swapTargets('s:0', l).includes('re:0'), 'an Out starter can go to IR');
  assert.ok(!model.swapTargets('b:fine', l).some((r) => r.startsWith('r')), 'a healthy player cannot');
  assert.deepEqual(plain(model.swapTargets('r:hurt', l)), ['s:0', 'b:out'], 'full roster: IR player only trades with eligible players it fits');
  assert.deepEqual(plain(model.applyMove('b:out', 're:0', l)), { starters: l.starters, taxi: [], reserve: ['hurt', 'out'] });
  assert.deepEqual(plain(model.applyMove('r:hurt', 's:0', l)), { starters: ['hurt', 'sg', 'sf', '0', 'c2'], taxi: [], reserve: ['pg'] });
  assert.deepEqual(plain(model.describeMove(l, model.applyMove('s:0', 're:0', l))), [{ id: 'pg', to: 'IR' }]);
});

test('IR players come off into an open spot only when the active roster has room', () => {
  const openUtil = { starters: ['pg', 'sg', 'sf', 'c2', '0'] };
  const room = irLineup({ ...openUtil, benchRoom: 1 });
  const targets = plain(model.swapTargets('r:hurt', room));
  assert.ok(targets.includes('be:0') && targets.includes('s:4'), 'open bench spot or the empty UTIL slot');
  assert.deepEqual(plain(model.applyMove('r:hurt', 'be:0', room)), { starters: room.starters, taxi: [], reserve: [] });
  assert.ok(!plain(model.swapTargets('r:hurt', irLineup(openUtil))).includes('s:4'), 'no room: the empty slot is off limits');
});

// A week where each player has their own team, so their games are theirs alone.
// games: { [player]: [[gameId, date, status, proj, actual?], ...] }
function optimizerWeek(games) {
  const scores = Object.entries(games).flatMap(([team, list]) => list.map(([id, date, status]) =>
    score(id, date, team, 'OPP', { status })));
  const rows = (i) => Object.entries(games).flatMap(([pid, list]) => list.filter((g) => g[i] != null)
    .map((g) => ({ player_id: pid, game_id: g[0], stats: { pts: g[i] } })));
  return {
    days: model.weekDays(scores),
    gamesByTeam: model.gamesByTeam(scores),
    proj: model.pointsByGame(rows(3), { pts: 1 }, scoring.scoreStats),
    actual: model.pointsByGame(rows(4), { pts: 1 }, scoring.scoreStats),
  };
}
const optimizerLineup = (slots, starters, bench, positions, games, locks = {}) => ({
  slots, starters, bench, locks,
  players: Object.fromEntries(Object.entries(positions).map(([id, pos]) => [id, { team: id, positions: pos }])),
  week: optimizerWeek(games),
});
const OPT_NOW = Date.parse('2026-10-21T12:00:00Z');

test('best lineup: scarce positions go to the players who can only fill them', () => {
  // Putting the C/PF star at C (their first position) would leave F to the weaker wing.
  const l = optimizerLineup(['C', 'F'], ['big', 'sf'], ['cen'], { big: ['C', 'PF'], cen: ['C'], sf: ['SF'] }, {
    big: [['b1', '2026-10-22', 'pre_game', 40]],
    cen: [['c1', '2026-10-22', 'pre_game', 30]],
    sf: [['s1', '2026-10-22', 'pre_game', 25]],
  });
  const plan = model.bestLineup(l, OPT_NOW);
  assert.deepEqual(plain(plan.starters), ['cen', 'big']);
  assert.deepEqual(plain(plan.changes.map((c) => [c.id, c.from, c.to])), [['cen', 'BN', 'C'], ['big', 'C', 'F'], ['sf', 'F', 'BN']]);
  assert.deepEqual([plan.before, plan.after], [65, 70]);
});

test('best lineup: worth is projected points per game left, so no games left is worth nothing', () => {
  const l = optimizerLineup(['UTIL'], ['two'], ['one', 'done'], { two: ['PG'], one: ['SG'], done: ['SF'] }, {
    two: [['t1', '2026-10-22', 'pre_game', 20], ['t2', '2026-10-24', 'pre_game', 10]],
    one: [['o1', '2026-10-23', 'pre_game', 16]],
    done: [['d1', '2026-10-20', 'complete', 50, 48]],
  });
  const plan = model.bestLineup(l, OPT_NOW);
  assert.deepEqual(plain(plan.starters), ['one']);
  assert.deepEqual(plain(plan.changes.map((c) => [c.id, c.perGame, c.gamesLeft])), [['one', 16, 1], ['two', 15, 2]]);
});

test('best lineup: benching a starter with a lockable finished game flags the lost score', () => {
  const l = optimizerLineup(['F'], ['kj'], ['wing'], { kj: ['SF', 'PF'], wing: ['SF'] }, {
    kj: [['k1', '2026-10-20', 'complete', 10, 12.5], ['k2', '2026-10-23', 'pre_game', 9]],
    wing: [['w1', '2026-10-22', 'pre_game', 20]],
  });
  const plan = model.bestLineup(l, OPT_NOW);
  const benched = plan.changes.find((c) => c.id === 'kj');
  assert.equal(benched.to, 'BN');
  assert.deepEqual([benched.lost.game.id, benched.lost.actual, benched.goodScore], ['k1', 12.5, false], '12.5 is not a green score');
  assert.equal(plan.changes.find((c) => c.id === 'wing').lost, null, 'a bench player had nothing to lock');
  const green = optimizerLineup(['F'], ['kj'], ['wing'], { kj: ['SF', 'PF'], wing: ['SF'] }, {
    kj: [['k1', '2026-10-20', 'complete', 10, 24], ['k2', '2026-10-23', 'pre_game', 9]],
    wing: [['w1', '2026-10-22', 'pre_game', 30]],
  });
  const big = model.bestLineup(green, OPT_NOW).changes.find((c) => c.id === 'kj');
  assert.deepEqual([big.lost.actual, big.goodScore], [24, true], 'benching a green score is flagged');
  // Worth at least the lockable score: a 12.5 finished game beats a 12 projection.
  const close = optimizerLineup(['F'], ['kj'], ['wing'], { kj: ['SF', 'PF'], wing: ['SF'] }, {
    kj: [['k1', '2026-10-20', 'complete', 10, 12.5], ['k2', '2026-10-23', 'pre_game', 9]],
    wing: [['w1', '2026-10-22', 'pre_game', 12]],
  });
  assert.deepEqual(plain(model.bestLineup(close, OPT_NOW).changes), []);
});

test('best lineup: locked players and players in a game right now stay put', () => {
  const l = optimizerLineup(['G', 'UTIL'], ['lock', 'live'], ['star', 'benchLive'], { lock: ['PG'], live: ['SG'], star: ['PG'], benchLive: ['SG'] }, {
    lock: [['l1', '2026-10-20', 'complete', 5, 4]],
    live: [['v1', '2026-10-21', 'in_game', 1]],
    star: [['s1', '2026-10-22', 'pre_game', 50]],
    benchLive: [['b1', '2026-10-21', 'in_game', 60]],
  }, { lock: 'l1' });
  const plan = model.bestLineup(l, OPT_NOW);
  assert.deepEqual(plain(plan.starters), ['lock', 'live']);
  assert.deepEqual(plain(plan.changes), []);
  assert.deepEqual(plain(plan.fixed), [{ id: 'lock', reason: 'locked' }, { id: 'live', reason: 'live' }, { id: 'benchLive', reason: 'live' }]);
});

test('best lineup: ties keep players where they are, then fill empty slots', () => {
  const l = optimizerLineup(['G', 'UTIL', 'C'], ['pg', 'sg', '0'], ['c'], { pg: ['PG'], sg: ['PG', 'SG'], c: ['C'] }, {
    pg: [['p1', '2026-10-22', 'pre_game', 20]],
    sg: [['g1', '2026-10-22', 'pre_game', 20]],
    c: [],
  });
  const plan = model.bestLineup(l, OPT_NOW);
  assert.deepEqual(plain(plan.starters), ['pg', 'sg', 'c'], 'a player with no games still beats an empty slot');
  assert.deepEqual(plain(plan.changes.map((c) => [c.id, c.from, c.to])), [['c', 'BN', 'C']]);
});

test('score tiers: green from 24, yellow from 15, red below', () => {
  assert.deepEqual([24, 30, 23.99, 15, 14.99, 0, -2].map(model.scoreTier), ['green', 'green', 'yellow', 'yellow', 'red', 'red', 'red']);
});

test('cheapest assignment matches brute force on random matrices', () => {
  // Deterministic pseudo-random numbers, so a failure always reproduces.
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const brute = (cost, row = 0, used = new Set()) => {
    if (row === cost.length) return 0;
    let best = Infinity;
    cost[row].forEach((c, j) => {
      if (used.has(j)) return;
      used.add(j);
      best = Math.min(best, c + brute(cost, row + 1, used));
      used.delete(j);
    });
    return best;
  };
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rand() * 5);
    const m = n + Math.floor(rand() * 3);
    const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.floor(rand() * 20) - 10));
    const cols = model.cheapestAssignment(cost);
    assert.equal(new Set(cols).size, n, 'each row gets its own column');
    assert.equal(cols.reduce((sum, j, i) => sum + cost[i][j], 0), brute(cost), JSON.stringify(cost));
  }
});

const nfl = (slots, starters, bench, players, proj, played = {}) => ({
  slots, starters, bench, proj, played,
  players: Object.fromEntries(Object.entries(players).map(([id, p]) => [id, typeof p === 'string' ? { positions: [p] } : p])),
});

test('NFL best lineup: superflex goes to a QB only when that beats the flex options', () => {
  // Two QBs: the second QB (18) beats the best remaining WR (12) at SUPER_FLEX, and the WR takes FLEX.
  const l = nfl(['QB', 'WR', 'FLEX', 'SUPER_FLEX'], ['qb1', 'wr1', 'rb1', 'wr2'], ['qb2', 'wr3'],
    { qb1: 'QB', qb2: 'QB', wr1: 'WR', wr2: 'WR', wr3: 'WR', rb1: 'RB' },
    { qb1: 22, qb2: 18, wr1: 15, wr2: 12, wr3: 9, rb1: 8 });
  const plan = model.bestNflLineup(l);
  assert.deepEqual(plain(plan.starters), ['qb1', 'wr1', 'wr2', 'qb2']);
  assert.deepEqual(plain(plan.changes.map((c) => [c.id, c.from, c.to, c.proj])),
    [['wr2', 'SUPER_FLEX', 'FLEX', 12], ['qb2', 'BN', 'SUPER_FLEX', 18], ['rb1', 'FLEX', 'BN', 8]]);
  assert.deepEqual([plan.before, plan.after], [57, 67]);
});

test('NFL best lineup: kicked-off players stay put, ruled-out players are worth nothing', () => {
  const l = nfl(['RB', 'WR'], ['rb1', 'wr1'], ['rb2', 'wr2'],
    { rb1: 'RB', rb2: 'RB', wr1: 'WR', wr2: { positions: ['WR'], injury: 'Out' } },
    { rb1: 5, rb2: 20, wr1: 6, wr2: 25 }, { rb1: true, rb2: false });
  const plan = model.bestNflLineup(l);
  assert.deepEqual(plain(plan.starters), ['rb1', 'wr1'], 'rb1 already played; wr2 is Out');
  assert.deepEqual(plain(plan.fixed), [{ id: 'rb1', reason: 'played' }]);
  assert.deepEqual(plain(plan.changes), []);
  // Questionable players can start; the dialog highlights them.
  l.players.wr2.injury = 'Questionable';
  assert.deepEqual(plain(model.bestNflLineup(l).starters), ['rb1', 'wr2']);
});

test('NFL best lineup: a bye week projects nothing and IDP flex takes any defender', () => {
  const l = nfl(['DL', 'IDP_FLEX', 'K'], ['dl1', 'lb1', 'k1'], ['db1', 'k2'],
    { dl1: 'DL', lb1: 'LB', db1: 'DB', k1: 'K', k2: 'K' },
    { dl1: 7, lb1: 6, db1: 9, k2: 8 });
  assert.deepEqual(plain(model.bestNflLineup(l).starters), ['dl1', 'db1', 'k2'], 'k1 is on bye');
});
