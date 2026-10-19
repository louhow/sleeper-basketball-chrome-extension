import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { scoreStats } = loadSnp().scoring;

test('weights every stat present in the league settings', () => {
  const settings = { pts: 0.5, reb: 1, ast: 1, to: -1, fga: 0 };
  assert.equal(scoreStats(settings, { pts: 20, reb: 10, ast: 5, to: 3, fga: 15, unscored: 99 }), 22);
});

test('parses bonus thresholds from the setting keys', () => {
  const settings = { pts: 1, bonus_pt_40p: 2, bonus_pt_50p: 3, bonus_reb_20p: 4, bonus_stl_7p: 5 };
  assert.equal(scoreStats(settings, { pts: 39 }), 39);
  assert.equal(scoreStats(settings, { pts: 45 }), 47);
  assert.equal(scoreStats(settings, { pts: 52 }), 57);
  assert.equal(scoreStats(settings, { pts: 0, reb: 20 }), 4);
  assert.equal(scoreStats(settings, { pts: 0, stl: 7 }), 5, 'bonus types unknown in advance still apply');
});

test('zero-weight bonuses add nothing', () => {
  assert.equal(scoreStats({ bonus_ast_15p: 0 }, { ast: 20 }), 0);
});
