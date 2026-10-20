import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { model, waivers, scoring } = loadSnp();
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Five roster spots; six players with one on IR and one on taxi leaves four active, so one open spot.
const league = (settings = {}) => ({
  roster_positions: ['PG', 'G', 'UTIL', 'BN', 'BN'],
  settings: { waiver_type: 2, waiver_budget: 100, ...settings },
});
const roster = (overrides = {}) => ({
  roster_id: 1,
  owner_id: 'u1',
  players: ['a', 'b', 'c', 'd', 'ir', 'tx'],
  starters: ['a', 'b', 'c'],
  reserve: ['ir'],
  taxi: ['tx'],
  settings: { waiver_budget_used: 26, waiver_position: 3 },
  ...overrides,
});
const full = () => roster({ players: ['a', 'b', 'c', 'd', 'e', 'ir', 'tx'] });

test('roster room counts only the active roster', () => {
  assert.equal(model.rosterRoom(league(), roster()), 1);
  assert.equal(model.rosterRoom(league(), full()), 0);
  assert.equal(model.faabLeft(league(), roster()), 74);
});

test('a full roster needs an active player dropped; IR and taxi drops do not count', () => {
  const claim = (drops, bid = '5') => model.claimError({ league: league(), roster: full(), waiver: true, bid, drops });
  assert.equal(claim([]), 'You must select 1 player to drop');
  assert.equal(claim(['ir']), 'You must select 1 player to drop');
  assert.equal(claim(['tx']), 'You must select 1 player to drop');
  assert.equal(claim(['e']), null);
  assert.equal(model.claimError({ league: league(), roster: roster(), waiver: true, bid: '0', drops: [] }), null, 'open spot, no drop needed');
});

test('FAAB bids must be whole dollars within the budget and minimum', () => {
  const bid = (b, settings) => model.claimError({ league: league(settings), roster: roster(), waiver: true, bid: b, drops: [] });
  assert.equal(bid(''), 'Invalid bid amount');
  assert.equal(bid('-1'), 'Bid cannot be negative');
  assert.equal(bid('2.5'), 'Bids are whole dollars');
  assert.equal(bid('75'), 'You only have $74 remaining');
  assert.equal(bid('74'), null);
  assert.equal(bid('1', { waiver_bid_min: 2 }), 'Bid must be a minimum of $2');
  assert.equal(model.claimError({ league: league(), roster: roster(), waiver: false, bid: '', drops: [] }), null, 'free agents take no bid');
  assert.equal(model.claimError({ league: league({ waiver_type: 0 }), roster: roster(), waiver: true, bid: '', drops: [] }), null, 'rolling waivers take no bid');
});

test('claims sort the way Sleeper processes them: bid, then priority', () => {
  const c = (id, bid, priority) => ({ transaction_id: id, settings: { waiver_bid: bid, priority } });
  const sorted = model.sortClaims([c('1', 5, 1), c('2', 9, 2), c('3', 5, 0), c('4', 5)]);
  assert.deepEqual(Array.from(sorted, (x) => x.transaction_id), ['2', '3', '1', '4']);
});

const games = [
  { game_id: 'g1', date: '2026-10-21', start_time: Date.parse('2026-10-22T02:00:00Z'), status: 'pre_game', metadata: { home_team: { team: 'LAL' }, away_team: { team: 'GSW' } } },
];
const week = {
  matchups: [],
  days: model.weekDays(games),
  gamesByTeam: model.gamesByTeam(games),
  games: [],
  proj: model.pointsByGame([{ player_id: 'new', game_id: 'g1', stats: { pts: 21.5 } }], { pts: 1 }, scoring.scoreStats),
  actual: {},
  research: {},
};
const player = (name, positions, team) => ({ name, position: positions[0], positions, team });
const state = (modal, overrides = {}) => ({
  ready: true,
  me: 'u1',
  today: '2026-10-19',
  now: Date.parse('2026-10-19T12:00:00Z'),
  week: 1,
  currentWeek: 1,
  weeks: { 1: week },
  league: league(),
  rosters: [full()],
  players: {
    new: player('New Guy', ['SF'], 'GSW'),
    a: player('Alpha', ['PG'], 'LAL'),
    b: player('Bravo', ['SG'], 'LAL'),
    c: player('Charlie', ['C'], 'LAL'),
    d: player('Delta', ['PF'], 'LAL'),
    e: player('Echo', ['SF'], 'LAL'),
    ir: player('Injured', ['C'], 'LAL'),
    tx: player('Rookie', ['PG'], 'LAL'),
  },
  modal,
  ...overrides,
});
const bid = (extra = {}) => ({ kind: 'bid', playerId: 'new', status: 'waiver', bid: '', drops: [], errors: [], ...extra });

test('waiver bid dialog mirrors Sleeper: title, full-roster banner, budget, drop list without IR', () => {
  const html = waivers.render(state(bid()));
  const out = text(html);
  assert.match(out, /Make Waiver Bid Bid for New Guy/);
  assert.match(out, /BN New Guy SF - GSW Wed @ LAL 10:00pm 21\.50 1/);
  assert.match(out, /Your roster is full, please select a player to drop/);
  assert.match(out, /Bid amount \(\$74 remaining\)/);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'tx']) assert.match(html, new RegExp(`data-drop="${id}"`));
  assert.doesNotMatch(html, /data-drop="ir"/, 'IR players are hidden, as in Sleeper');
  assert.match(html, /data-action="submit-claim"[^>]*>Make Waiver Bid</);
});

test('free agents get the add dialog, no bid; selected drops are highlighted', () => {
  const html = waivers.render(state(bid({ status: 'free_agent', drops: ['e'] })));
  assert.match(text(html), /Add Player Add New Guy to your roster/);
  assert.doesNotMatch(html, /data-bid/);
  assert.match(html, /class="dp-row selected" data-drop="e" aria-pressed="true"/);
});

test('room on the roster says so instead of asking for a drop', () => {
  const out = text(waivers.render(state(bid(), { rosters: [roster()] })));
  assert.match(out, /You have 1 empty slot on your roster\. You can waiver this player without dropping any players\./);
});

test('claims dialog lists pending claims by bid with edit and cancel', () => {
  const claims = [
    { transaction_id: 't1', leg: 1, adds: { new: 1 }, drops: { e: 1 }, settings: { waiver_bid: 3 } },
    { transaction_id: 't2', leg: 1, adds: { d: 1 }, drops: null, settings: { waiver_bid: 12 } },
  ];
  const html = waivers.render(state({ kind: 'claims', errors: [] }, { claims }));
  const out = text(html);
  assert.match(out, /Waiver Claims \$74 remaining · waiver position 3/);
  assert.match(out, /1 \+ Delta .* 2 \+ New Guy .* − Echo/);
  assert.match(html, /data-claim-bid="t2" value="12"/);
  assert.match(html, /data-claim-cancel="t1"/);
  assert.match(text(waivers.render(state({ kind: 'claims', errors: [] }, { claims: [] }))), /No pending claims/);
});

test('logged out: the dialog says how to bid instead of failing', () => {
  assert.match(text(waivers.render(state(bid(), { me: null }))), /Log in to Sleeper with a team in this league to bid\./);
});
