import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { view, model, scoring } = loadSnp();
const { render } = view;

const player = (name, positions, team, injury) => ({ name, position: positions[0], positions, team, injury });
const games = [
  { game_id: 'g1', date: '2026-10-21', start_time: Date.parse('2026-10-22T02:00:00Z'), status: 'pre_game', metadata: { home_team: { team: 'LAL' }, away_team: { team: 'GSW' } } },
  { game_id: 'g2', date: '2026-10-25', start_time: Date.parse('2026-10-25T20:00:00Z'), status: 'complete', metadata: { home_team: { team: 'UTA' }, away_team: { team: 'LAL' } } },
];
const week = {
  matchups: [
    { roster_id: 1, matchup_id: 1, starters: ['a', 'b', '0'], points: 12.5, players_points: { a: 12.5 } },
    { roster_id: 2, matchup_id: 1, starters: [], points: 3 },
  ],
  days: model.weekDays(games),
  gamesByTeam: model.gamesByTeam(games),
  games: games.map((g) => ({ start: g.start_time, status: g.status })),
  proj: model.pointsByGame([{ player_id: 'a', game_id: 'g1', stats: { pts: 30.79 } }, { player_id: 'a', game_id: 'g2', stats: { pts: 39.83 } }], { pts: 1 }, scoring.scoreStats),
  actual: model.pointsByGame([{ player_id: 'a', game_id: 'g2', stats: { pts: 12.5 } }], { pts: 1 }, scoring.scoreStats),
  research: { a: { owned: 99.7, started: 97.0 }, b: { owned: 94.3, started: 22.8 } },
};
const state = (overrides = {}) => ({
  tab: 'team',
  openCalls: new Set(),
  today: '2026-10-19',
  week: 1,
  minWeek: 1,
  maxWeek: 21,
  weeks: { 1: week },
  league: { name: 'Test League', roster_positions: ['PG', 'G', 'UTIL', 'BN', 'BN'], settings: { reserve_slots: 2, taxi_slots: 1 } },
  usersById: {
    u1: { display_name: 'louhow', avatar: 'abc', metadata: { team_name: 'COOKIE <MONSTER>' } },
    u2: { display_name: 'rival', metadata: { team_name: 'Cling Kong' } },
  },
  rosters: [
    { roster_id: 1, owner_id: 'u1', settings: { wins: 2, losses: 1 }, players: ['a', 'b', 'c', 'e', 'd', 'g', 'f'], starters: ['a', 'b', '0'], taxi: [], reserve: ['f'] },
    { roster_id: 2, owner_id: 'u2', settings: { wins: 0, losses: 0 }, players: [] },
  ],
  rosterId: 1,
  players: {
    a: player('Luka Doncic', ['PG'], 'LAL'),
    b: player('Jeremiah Fears', ['PG', 'SG'], 'NOP', 'Questionable'),
    d: player('Bench Four', ['SF', 'PF'], null),
    e: player('Bench Center', ['C'], 'BOS'),
    g: player('Bench Guard', ['PG'], 'BOS'),
    f: player('Hurt Six', ['PF'], 'MIA', 'Out'),
  },
  picks: [{ season: '2027', round: 1, original: 1 }, { season: '2027', round: 2, original: 2 }],
  ...overrides,
});
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('team card shows record, live points, lock-in projection and opponent', () => {
  const out = text(render(state(), []));
  assert.match(out, /COOKIE &lt;MONSTER&gt; louhow · 2-1 12\.50 proj 39\.83 vs Cling Kong/);
  assert.match(out, /Week 1 OCT 19-25/);
});

test('starters use league slots, with combo slots split by color', () => {
  const html = render(state(), []);
  assert.match(html, /class="slot split pg sg" style="--a:var\(--pg\);--b:var\(--sg\)">G</);
  const out = text(html);
  assert.match(out, /PG Luka Doncic PG - LAL 100% Rostered \| 97% Start 12\.50 proj 39\.83/);
  assert.match(out, /G Jeremiah Fears PG SG - NOP Questionable 95% Rostered \| 23% Start/);
  assert.match(out, /UTIL Empty/);
});

test('day strip shows projections before games and actual points after', () => {
  const out = text(render(state(), []));
  assert.match(out, /W 30\.79 vs GSW/);
  assert.match(out, /S 12\.50 @UTA Final/);
});

test('reserve and taxi pad to the league slot counts; picks credit the original team', () => {
  const out = text(render(state(), []));
  assert.match(out, /Bench BN Bench Guard .* BN Bench Four SF PF - FA .* BN Bench Center .* BN Player #c/, 'bench sorted by primary position, unknowns last');
  assert.match(out, /Injured Reserve IR Hurt Six .* IR Empty/);
  assert.match(out, /Taxi Squad TX Empty/);
  assert.match(out, /Draft Picks 2027 1st Rd 2027 2nd Rd via Cling Kong/);
});

test('escapes user-controlled text', () => {
  const html = render(state(), []);
  assert.ok(html.includes('COOKIE &lt;MONSTER&gt;'));
  assert.ok(!html.includes('<MONSTER>'));
});

test('api tab shows graphql request bodies and skips raw links for POSTs', () => {
  const log = [
    { id: 2, path: 'graphql scores (week 1)', url: 'https://sleeper.com/graphql', request: 'query scores { x }', status: 200, ms: 80, bytes: 100, at: 0, json: { data: {} } },
    { id: 1, path: '/v1/league/1', url: 'https://api.sleeper.app/v1/league/1', status: 200, ms: 42.4, bytes: 900, at: 0, json: { name: 'L' } },
  ];
  const html = render(state({ tab: 'api', openCalls: new Set([1, 2]) }), log);
  assert.match(text(html), /200 graphql scores \(week 1\) 80 ms · 100 B/);
  assert.match(html, /<pre class="request">query scores \{ x \}<\/pre>/);
  assert.equal((html.match(/Open raw response/g) || []).length, 1);
});

test('lineup is read-only unless the logged-in user owns the roster', () => {
  assert.doesNotMatch(render(state(), []), /data-spot=/, 'logged out');
  assert.doesNotMatch(render(state({ me: 'u2' }), []), /data-spot=/, 'someone else\'s team');
  const html = render(state({ me: 'u1', currentWeek: 1 }), []);
  assert.match(html, /<button class="slot pg" data-spot="s:0"/);
  assert.match(html, /data-spot="b:d"/, 'bench players are buttons too');
  assert.doesNotMatch(html, /data-spot="[^"]*f"/, 'reserve is not part of the lineup');
  assert.match(text(html), /Tap on a position button to update your lineup/);
  assert.doesNotMatch(render(state({ me: 'u1', currentWeek: 2 }), []), /data-spot=/, 'past weeks are read-only');
});

test('picking a spot highlights who it can swap with and dims the rest', () => {
  const html = render(state({ me: 'u1', currentWeek: 1, swap: 's:0' }), []);
  assert.match(html, /<article class="card selected">\s*<div class="top">\s*<button class="slot pg" data-spot="s:0"/);
  assert.match(html, /<article class="card target">\s*<div class="top">\s*<button class="slot split pg sg"[^>]*data-spot="s:1"/);
  assert.match(html, /<article class="card dim">\s*<div class="top">\s*<button class="slot bn" data-spot="b:d"/);
  assert.match(text(html), /Pick a player to swap with Luka Doncic/);
});

test('logged-in leg data wins: starters, projection and locked games', () => {
  const s = state({ me: 'u1', currentWeek: 1 });
  s.weeks = { 1: { ...week, legs: [{ roster_id: 1, starters: ['b', 'a', '0'], proj_points: 157.23, points: 4, starters_games: { a: 'g1' } }] } };
  const html = render(s, []);
  const out = text(html);
  assert.match(out, /4\.00 proj 157\.23/);
  assert.match(out, /PG Jeremiah Fears .* G Luka Doncic/);
  assert.match(html, /class="day game locked"/);
  assert.match(out, /locked 30\.79/);
});

const taxiState = (overrides = {}) => {
  // Week 1's first game tips off Oct 21; nothing has been played on Oct 19.
  const schedule = { ...week, games: [{ start: Date.parse('2026-10-21T23:00:00Z'), status: 'pre_game' }] };
  const s = state({ me: 'u1', currentWeek: 1, seasonType: 'regular', now: Date.parse('2026-10-19T12:00:00Z'), weeks: { 1: schedule }, ...overrides });
  s.league.settings = { ...s.league.settings, taxi_slots: 2, taxi_years: 2, taxi_allow_vets: 1, taxi_deadline: 4 };
  s.rosters[0].taxi = ['t1'];
  s.rosters[0].players = [...s.rosters[0].players, 't1'];
  s.players.t1 = { name: 'Taxi Kid', position: 'PG', positions: ['PG'], team: 'ATL', years_exp: 1 };
  s.players.d.years_exp = 0;
  return s;
};

test('taxi is editable before the deadline, with the league rule spelled out', () => {
  const html = render(taxiState(), []);
  assert.match(html, /data-spot="t:t1"/);
  assert.match(html, /data-spot="te:0"/, 'open taxi slot');
  assert.match(text(html), /Players with 2 or fewer years of experience can move to taxi until the first game of the regular season tips off\./);
  const picking = render(taxiState({ swap: 'b:d' }), []);
  assert.match(picking, /<article class="card target">\s*<div class="top">\s*<button class="slot tx" data-spot="t:t1"/);
});

test('taxi locks once the regular season tips off', () => {
  const s = taxiState({ now: Date.parse('2026-10-22T12:00:00Z') });
  const out = text(render(s, []));
  assert.match(out, /Taxi is locked for the season: players can only move up to the active roster \(roster is full\)\./);
  const picking = render({ ...s, swap: 'b:d' }, []);
  assert.doesNotMatch(picking, /class="card target">\s*<div class="top">\s*<button class="slot tx"/, 'no moves onto taxi');
  assert.doesNotMatch(render(s, []), /data-spot="t:/, 'no dead buttons: a full roster leaves taxi players nowhere to go');
});

test('taxi is read-only for other weeks and other teams', () => {
  assert.doesNotMatch(render(taxiState({ week: 2, weeks: { 2: week } }), []), /data-spot="t:/);
  assert.doesNotMatch(render(taxiState({ me: 'u2' }), []), /data-spot="t:/);
});
