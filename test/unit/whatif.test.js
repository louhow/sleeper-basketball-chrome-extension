import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnp } from './load.js';

const { whatif, scoring, ui, view, matchup, model } = loadSnp();
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const LEAGUE = { pts: 0.5, reb: 1, blk: 2, fgm: 0, sp: 0, custom_stat: 0 };
const state = (whatIf = {}) => ({
  league: { scoring_settings: LEAGUE },
  whatIf: { enabled: true, overrides: {}, on: false, open: true, showAll: false, drafts: {}, ...whatIf },
});

test('settings list follows Sleeper, hides seconds played and keeps unknown league keys', () => {
  const keys = Array.from(scoring.settingsList(LEAGUE), ([key]) => key);
  assert.deepEqual(keys.slice(0, 3), ['pts', 'ast', 'reb']);
  assert.ok(!keys.includes('sp'));
  assert.equal(keys.at(-1), 'custom_stat');
});

test('only real changes count as overrides', () => {
  // Objects from the extension's VM context have their own prototypes, so compare as JSON.
  const json = (o) => JSON.stringify(o);
  assert.equal(json(scoring.changedOnly(LEAGUE, { pts: 0.5, reb: 1.5, ast: 0, blk: NaN })), json({ reb: 1.5 }));
  assert.equal(json(scoring.withOverrides(LEAGUE, { reb: 1.5 })), json({ ...LEAGUE, reb: 1.5 }));
});

test('what-if applies only when switched on with a change', () => {
  assert.equal(ui.whatIfOn(state({ on: true })), false, 'nothing changed yet');
  assert.equal(ui.whatIfOn(state({ overrides: { pts: 1 } })), false, 'switched to league');
  const s = state({ overrides: { pts: 1 }, on: true });
  assert.equal(ui.whatIfOn(s), true);
  assert.equal(ui.whatIfOn(state({ overrides: { pts: 1 }, on: true, enabled: false })), false, 'admin tools off (no ?snp-admin=1)');
  assert.equal(ui.scoringOf(state({ overrides: { pts: 1 }, on: true, enabled: false })).pts, 0.5);
  assert.equal(ui.scoringOf(s).pts, 1);
  assert.equal(ui.scoringOf(state({ overrides: { pts: 1 } })).pts, 0.5);
  assert.equal(ui.whatIfChanges(s), 'Points Scored 0.5 → 1');
  const many = state({ overrides: { pts: 1, reb: 2, blk: 3, fgm: 1, ast: 1 }, on: true });
  assert.match(ui.whatIfChanges(many), /and 2 more$/);
});

test('collapsed: the switch, with what-if disabled until a value changes', () => {
  const html = whatif.render(state({ open: false }));
  assert.doesNotMatch(html, /wi-pop/);
  assert.match(html, /data-wi="whatif" disabled title="Change a value first"/);
  const on = whatif.render(state({ open: false, overrides: { pts: 1 }, on: true }));
  assert.match(on, /<div class="wi on">/);
  assert.match(on, /aria-checked="true" data-wi="whatif" >What-if<span class="count">1<\/span>/);
});

test('editor lists the league\'s scored stats first and marks changes with the league value', () => {
  const html = whatif.render(state({ overrides: { reb: 1.5 }, drafts: { pts: '0.' } }));
  const out = text(html);
  assert.match(out, /Points Scored Rebounds League 1 ↺ Blocks Show 25 more not scored in your league/);
  assert.match(html, /data-wi-key="pts" value="0\."/, 'text being typed stays as typed');
  assert.match(html, /<div class="wi-row changed">\s*<label for="wi-reb">Rebounds<\/label>\s*<input[^>]*value="1\.5">/);
  assert.doesNotMatch(html, /data-wi-key="fgm"/, 'unscored stats wait behind "Show more"');
  assert.match(whatif.render(state({ showAll: true })), /data-wi-key="fgm"/);
  assert.match(whatif.render(state({ overrides: { fgm: 1 } })), /data-wi-key="fgm"[^>]*value="1"/, 'a changed unscored stat always shows');
  assert.match(html, /<button data-wi="reset" >Reset to league<\/button>/);
  assert.match(whatif.render(state()), /data-wi="reset" disabled/);
});

test('typed values parse once they are numbers', () => {
  assert.equal(whatif.parse('1.5'), 1.5);
  assert.equal(whatif.parse('-2'), -2);
  assert.equal(whatif.parse('.5'), 0.5);
  assert.equal(whatif.parse('3.'), 3);
  for (const t of ['', '-', '.', '1e3', 'abc']) assert.equal(whatif.parse(t), null, t);
});

// The Team and Matchup tabs, with Sleeper's own totals (league scoring) set.
const games = [
  { game_id: 'g1', date: '2026-10-21', start_time: Date.parse('2026-10-22T01:00:00Z'), status: 'complete', metadata: { home_team: { team: 'LAL' }, away_team: { team: 'GSW' } } },
  { game_id: 'g2', date: '2026-10-25', start_time: Date.parse('2026-10-25T20:00:00Z'), status: 'pre_game', metadata: { home_team: { team: 'UTA' }, away_team: { team: 'LAL' } } },
];
function panelState(whatIf) {
  const settings = whatIf ? { pts: 2 } : { pts: 1 };
  const pts = (rows) => model.pointsByGame(rows, settings, scoring.scoreStats);
  return {
    tab: 'page',
    page: 'team',
    openCalls: new Set(),
    today: '2026-10-22',
    now: Date.parse('2026-10-22T12:00:00Z'),
    me: 'u1',
    week: 1,
    currentWeek: 1,
    minWeek: 1,
    maxWeek: 21,
    ready: true,
    league: { status: 'in_season', scoring_settings: { pts: 1 }, roster_positions: ['PG', 'BN'], settings: {} },
    usersById: { u1: { display_name: 'louhow' }, u2: { display_name: 'rival' } },
    rosters: [
      { roster_id: 1, owner_id: 'u1', settings: {}, players: ['luka'] },
      { roster_id: 2, owner_id: 'u2', settings: {}, players: [] },
    ],
    rosterId: 1,
    players: { luka: { name: 'Luka Doncic', first: 'Luka', last: 'Doncic', position: 'PG', positions: ['PG'], team: 'LAL' } },
    weeks: { 1: {
      matchups: [{ roster_id: 1, matchup_id: 1, points: 99, players_points: { luka: 99 } }, { roster_id: 2, matchup_id: 1, points: 0 }],
      legs: [
        { roster_id: 1, matchup_id: 1, starters: ['luka'], points: 99, proj_points: 111, starters_games: { luka: 'g1' } },
        { roster_id: 2, matchup_id: 1, starters: [], points: 0, proj_points: 0, starters_games: {} },
      ],
      days: model.weekDays(games),
      gamesByTeam: model.gamesByTeam(games),
      games: [],
      proj: pts([{ player_id: 'luka', game_id: 'g1', stats: { pts: 30 } }, { player_id: 'luka', game_id: 'g2', stats: { pts: 25 } }]),
      actual: pts([{ player_id: 'luka', game_id: 'g1', stats: { pts: 40 } }]),
      research: {},
      ranks: {},
    } },
    whatIf: { enabled: true, overrides: whatIf ? { pts: 2 } : {}, on: Boolean(whatIf), open: false, showAll: false, drafts: {} },
  };
}

test('team tab: league scoring shows Sleeper\'s totals; what-if adds them up and says so', () => {
  const league = render(panelState(false));
  assert.match(league.out, /louhow .* 99\.00 proj 111\.00/);
  assert.doesNotMatch(league.html, /whatif/);
  assert.match(league.html, /data-action="optimize"/);

  const wi = render(panelState(true));
  assert.match(wi.html, /<div class="app whatif">/);
  assert.match(wi.out, /What-if scoring Points Scored 1 → 2\. Fantasy points here aren't your league's; Lock-In and Optimize are off\. Use league scoring/);
  assert.match(wi.out, /louhow .* 80\.00 proj 80\.00/, 'the locked game, rescored');
  assert.match(wi.out, /Luka Doncic .* 80\.00 lock 80\.00/);
  assert.doesNotMatch(wi.out, /99\.00|111\.00/);
  assert.match(wi.html, /<button class="optimize" disabled/);
});

test('matchup tab: what-if replaces Sleeper\'s totals and turns off locking', () => {
  const s = { ...panelState(true), page: 'matchup' };
  s.weeks[1].legs[0].starters_games = {};
  const out = text(matchup.render(s));
  assert.doesNotMatch(out, /111\.00/);
  assert.match(out, /COOKIE|louhow/);
  assert.match(out, /pts 80\.00/);
  assert.doesNotMatch(matchup.render(s), /data-lock=/, 'a lock is real points');
  const league = { ...panelState(false), page: 'matchup' };
  league.weeks[1].legs[0].starters_games = {};
  assert.match(text(matchup.render(league)), /111\.00/);
  assert.match(matchup.render(league), /data-lock="1:luka"/);
});

function render(s) {
  const html = view.render(s, []);
  return { html, out: text(html) };
}

test('rank shift: places moved when ranked by what-if points, ties sharing a rank', () => {
  const before = { a: 32, b: 31, c: 30, d: 30 };
  const after = { a: 36, b: 35, c: 70, d: 30 };
  const json = (o) => JSON.stringify(o);
  assert.equal(json(model.rankShift(['a', 'b', 'c', 'd'], (id) => before[id], (id) => after[id])), json({ a: -1, b: -1, c: 2, d: -1 }));
  assert.equal(json(model.rankShift(['c', 'd'], (id) => before[id], (id) => before[id])), json({ c: 0, d: 0 }), 'nothing moves until a value changes');
});

test('places: highest first, ties sharing a place', () => {
  const v = { a: 10, b: 30, c: 30, d: 5 };
  assert.equal(JSON.stringify(model.ranks(['a', 'b', 'c', 'd'], (id) => v[id])), JSON.stringify({ a: 3, b: 1, c: 1, d: 4 }));
});

test('shift tint: green up, red down, deeper with the size of the move', () => {
  assert.equal(model.shiftTint(0, 4), '');
  assert.equal(model.shiftTint(4, 4), 'rgba(52, 168, 83, 0.90)');
  assert.equal(model.shiftTint(-1, 4), 'rgba(214, 69, 80, 0.38)');
  assert.ok(model.shiftTint(-4, 4).endsWith('0.90)'), 'the biggest drop is the reddest');
});
