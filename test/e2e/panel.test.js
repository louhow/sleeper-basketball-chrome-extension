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
const panel = (sel = '') => `#sleeper-nba-panel ${sel}`;

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
<div class="center-panel"><div class="league-panel"><div class="league-panel-tabs-wrapper"><div class="postdraft-panel">
  <div class="center-tab-selector"><div>MATCHUP</div><div class="selected">TEAM</div><div>LEAGUE</div><div>PLAYERS</div></div>
  <div><div class="empty-panel-container"><p>Team panel not yet available for NBA fantasy.</p><p>Please use the Sleeper mobile app</p><div class="footer">Responsible Play</div></div></div>
</div></div></div></div>`;
const FAKE_TOKEN = 'e2e-fake-session-token';
const LOGGED_IN = TEAM_TAB.replace('<title>Sleeper</title>', `<title>Sleeper</title><script>localStorage.setItem('token', '${FAKE_TOKEN}')</script>`);
const LOGGED_OUT = TEAM_TAB.replace('<title>Sleeper</title>', "<title>Sleeper</title><script>localStorage.removeItem('token')</script>");
const NO_PLACEHOLDER = '<!doctype html><title>Sleeper</title><body style="margin:0;background:rgb(16,33,49)"></body>';

let context;
let page;
let documentBody = LOGGED_OUT;

// Stand-in for Sleeper's authenticated GraphQL: everything that carries the
// session token is answered here and recorded, so tests never touch a real lineup.
const sleeper = {
  me: null, // user id of the roster under test
  legs: {}, // round -> matchup legs
  mutations: [],
  failNextMutation: false,
};
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
  if (!auth) return route.continue(); // public queries like scores stay live
  assert.equal(auth, FAKE_TOKEN, 'sends the page session token');
  const { query, variables } = req.postDataJSON();
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (/query me\b/.test(query)) return json({ data: { me: { user_id: sleeper.me } } });
  const round = Number(query.match(/round: (\d+)/)?.[1]);
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
  page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => console.error('[pageerror]', e));
});

after(() => context?.close());

test('fills the empty Team tab in place', async () => {
  await page.goto(TEAM_URL);
  await page.locator(panel('.card .days')).first().waitFor({ timeout: 30000 });
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
  assert.match(await page.locator(panel('.line2')).first().textContent(), /\d+% Rostered \| \d+% Start/);
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
  await page.locator(panel('[data-tab="team"]')).click();
});

test('unmounts off the team route and restores the placeholder', async () => {
  await page.evaluate((id) => history.pushState({}, '', `/leagues/${id}/matchup`), LEAGUE);
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
  assert.match(await shadowText('.hint'), /Tap on a position button/);
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
  await page.locator(panel('[data-tab="team"]')).click();
  documentBody = LOGGED_OUT;
});
