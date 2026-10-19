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
  const { starters, slots } = lineup();
  assert.deepEqual(plain(model.applySwap('s:0', 's:1', starters, slots)), ['sg', 'pg', 'sf', '0', 'c2']);
  assert.deepEqual(plain(model.applySwap('b:c', 's:3', starters, slots)), ['pg', 'sg', 'sf', 'c', 'c2'], 'bench player fills an empty slot');
  assert.deepEqual(plain(model.applySwap('s:2', 'b:pf', starters, slots)), ['pg', 'sg', 'pf', '0', 'c2'], 'benched starter just drops out');
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
