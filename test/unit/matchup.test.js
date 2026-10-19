import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { matchup, model, scoring } = loadSnp();
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const games = [
  { game_id: 'g1', date: '2026-10-21', start_time: Date.parse('2026-10-22T01:00:00Z'), status: 'complete', metadata: { home_team: { team: 'LAL' }, away_team: { team: 'GSW' } } },
  { game_id: 'g2', date: '2026-10-25', start_time: Date.parse('2026-10-25T20:00:00Z'), status: 'pre_game', metadata: { home_team: { team: 'UTA' }, away_team: { team: 'LAL' } } },
  { game_id: 'g3', date: '2026-10-22', start_time: Date.parse('2026-10-22T23:00:00Z'), status: 'pre_game', metadata: { home_team: { team: 'PHI' }, away_team: { team: 'CLE' } } },
];
const pts = (rows) => model.pointsByGame(rows, { pts: 1 }, scoring.scoreStats);
const week = (legs) => ({
  matchups: [],
  legs,
  days: model.weekDays(games),
  gamesByTeam: model.gamesByTeam(games),
  proj: pts([{ player_id: 'luka', game_id: 'g1', stats: { pts: 30.79 } }, { player_id: 'luka', game_id: 'g2', stats: { pts: 39.83 } }, { player_id: 'don', game_id: 'g3', stats: { pts: 25.75 } }]),
  actual: pts([{ player_id: 'luka', game_id: 'g1', stats: { pts: 41.5 } }]),
  research: {},
  ranks: { 10: 3, 5: 7 },
});
const legs = (lukaLock) => [
  { roster_id: 10, matchup_id: 7, starters: ['luka'], points: null, proj_points: 157.23, starters_games: lukaLock ? { luka: lukaLock } : {} },
  { roster_id: 5, matchup_id: 7, starters: ['don'], points: null, proj_points: 181.21, starters_games: {} },
];
const state = (overrides = {}) => ({
  page: 'matchup',
  league: { name: 'Basketball Butter', status: 'in_season', roster_positions: ['PG', 'BN'], settings: { reserve_slots: 1 } },
  usersById: {
    u1: { display_name: 'louhow', metadata: { team_name: 'COOKIE MONSTER' } },
    u2: { display_name: 'badonkeyds', metadata: { team_name: 'Cling Kong' } },
  },
  rosters: [
    { roster_id: 10, owner_id: 'u1', settings: { wins: 0, losses: 0 }, players: ['luka', 'bench1'], reserve: [] },
    { roster_id: 5, owner_id: 'u2', settings: { wins: 0, losses: 0 }, players: ['don'], reserve: ['hurt'] },
  ],
  players: {
    luka: { name: 'Luka Doncic', first: 'Luka', last: 'Doncic', positions: ['PG'], position: 'PG', team: 'LAL' },
    don: { name: 'Donovan Mitchell', first: 'Donovan', last: 'Mitchell', positions: ['SG', 'PG'], position: 'SG', team: 'CLE' },
    bench1: { name: 'Bench Guy', first: 'Bench', last: 'Guy', positions: ['SF'], position: 'SF', team: 'BOS' },
    hurt: { name: 'Hurt Guy', first: 'Hurt', last: 'Guy', positions: ['C'], position: 'C', team: 'MIA', injury: 'Out' },
  },
  rosterId: 10,
  me: 'u1',
  week: 1,
  currentWeek: 1,
  minWeek: 1,
  maxWeek: 21,
  now: Date.parse('2026-10-22T12:00:00Z'),
  weeks: { 1: week(legs()) },
  ...overrides,
});

test('header pairs both teams with win %, record, rank and projection', () => {
  const out = text(matchup.render(state()));
  assert.match(out, /@louhow COOKIE MONSTER – 37% WIN 0-0 \(#3\) 157\.23 VS @badonkeyds Cling Kong – 63% WIN 0-0 \(#7\) 181\.21/);
  assert.match(out, /Yet to play \(1\) Yet to play \(1\)/);
});

test('starter rows mirror the slot with the lockable game and logos', () => {
  const html = matchup.render(state());
  const out = text(html);
  assert.match(out, /L\. Doncic PG • LAL – vs GSW Final · Wed pts 41\.50 🔓 LOCK-IN PG D\. Mitchell SG PG • CLE – @ PHI Thu 7:00pm proj 25\.75 NOT LOCKED/);
  assert.match(html, /<button class="lk open" data-lock="10:luka"/);
  assert.match(html, /class="chip done current"[^>]*><img src="https:\/\/sleepercdn\.com\/images\/team_logos\/nba\/gsw\.webp"/);
  assert.match(out, /Bench B\. Guy SF • BOS – No games this week – BN Empty/);
  assert.match(out, /Injured Reserve Empty IR H\. Guy Out/);
});

test('lock-in asks to confirm, and shows locked games as final', () => {
  const confirming = matchup.render(state({ lockConfirm: '10:luka' }));
  assert.match(confirming, /data-lock-confirm="10:luka"[^>]*>Lock 41\.50</);
  assert.match(confirming, /data-lock-cancel/);
  const locked = text(matchup.render(state({ weeks: { 1: week(legs('g1')) } })));
  assert.match(locked, /L\. Doncic PG • LAL 41\.50 vs GSW .* 🔒 LOCKED/);
  assert.match(locked, /Yet to play \(0\)/);
});

test('lock controls only for rosters the logged-in user owns', () => {
  const theirs = matchup.render(state({ rosterId: 5 }));
  assert.deepEqual(theirs.match(/data-lock="[^"]+"/g), ['data-lock="10:luka"'], 'your side keeps its lock even on the right');
  const loggedOut = matchup.render(state({ me: null }));
  assert.doesNotMatch(loggedOut, /data-lock=/);
});
