import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { card } = loadSnp();
const scoring = { pts: 1, reb: 1.2 };

test('game log merges projections with played games, in date order', () => {
  const log = {
    proj: { 1: [
      { game_id: 'g2', date: '2026-10-24', week: 1, opponent: 'MIN', is_away_team: true, stats: { pts: 20 } },
      { game_id: 'g1', date: '2026-10-21', week: 1, opponent: 'GSW', is_away_team: false, stats: { pts: 30, reb: 5 } },
    ] },
    stats: { 1: [{ game_id: 'g1', date: '2026-10-21', week: 1, opponent: 'GSW', stats: { pts: 40, reb: 10, sp: 2160, fgm: 15, fga: 25 } }] },
  };
  const rows = card.gameLog(log, scoring);
  assert.deepEqual(Array.from(rows, (r) => r.opp), ['GSW', 'MIN']);
  const [played, upcoming] = rows;
  assert.equal(played.played, true);
  assert.equal(played.proj, 36);
  assert.equal(played.fpts, 52);
  assert.equal(played.min, 36);
  assert.equal(played.fgm, 15);
  assert.equal(upcoming.played, undefined);
  assert.equal(upcoming.away, true);
  assert.equal(upcoming.proj, 20);
});

test('career rows turn season totals into per-game averages and percentages', () => {
  const r = card.careerRow(2025, { gp: 50, pts: 1000, reb: 400, sp: 108000, fgm: 400, fga: 800, ftm: 90, fta: 100, tpm: 100, pos_rank_std: 3 }, scoring);
  assert.equal(r.fpts, 1480);
  assert.equal(r.pts, 20);
  assert.equal(r.min, 36);
  assert.equal(r.fgp, 0.5);
  assert.equal(r.ftp, 0.9);
  assert.equal(r.tpm, 2);
  assert.equal(r.rank, 3);
});

test('labels: NBA seasons span two years, heights in feet and inches', () => {
  assert.equal(card.seasonLabel(2026), "'26-'27");
  assert.equal(card.height('79'), '6\'7"');
  assert.equal(card.height(null), '-');
});

test('game log colors fantasy points by score tier', () => {
  const game = (id, date, pts) => ({ game_id: id, date, week: 1, opponent: 'GSW', stats: { pts } });
  const s = {
    modal: { kind: 'player', playerId: 'p1', season: 2026 },
    league: { season: '2026', scoring_settings: { pts: 1 } },
    players: { p1: { name: 'Test Player', positions: ['PG'], team: 'LAL' } },
    cards: { p1: { seasons: [2026], logs: { 2026: { stats: { 1: [game('a', '2026-10-21', 30), game('b', '2026-10-22', 18), game('c', '2026-10-23', 9)] } } } } },
  };
  const tiers = [...card.render(s).matchAll(/<td class="fpts ([a-z]+)">([\d.]+)</g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(tiers, [['30.00', 'green'], ['18.00', 'yellow'], ['9.00', 'red']]);
});
