# Agent notes: Sleeper Basketball Chrome Extension

MV3 Chrome extension that fills Sleeper's web NBA Team and Matchup tabs and enables waivers, using the same APIs as Sleeper's own apps.
User-facing docs: `README.md` (install, privacy) and `docs/DETAILS.md` (features, API calls, tests).

## Workflow

- Commit and push to `main` after each finished, tested change (remote: `github.com/louhow/sleeper-basketball-chrome-extension`, public).
- Never add Claude as author or co-author on commits.
- Before committing, run `npm test` (unit) and `npm run test:e2e` (headless Chromium); both must pass with no page errors.
- Look at the screenshots in `test-results/` after UI changes; layout and spacing matter.
- Browser testing is headless only (Playwright). The user's real Chrome is for reading live data with their session, not for testing.
- Writes against the live league (bids, lineup, taxi, IR) only with the user's go-ahead; tell them exactly what is left to undo.
- npm registry is `registry.npmjs.org` (see `.npmrc`); no work registries.

## Layout

- `manifest.json`: content scripts run at `document_start` on `sleeper.com`, in this order: `scoring`, `model`, `api`, `ui`, `view`, `matchup`, `waivers`, `optimize`, `nfl`, `card`, `whatif`, `content`. `page-hook.js` runs separately in the page's MAIN world.
- `src/model.js`: pure rules (schedule, Lock-In, lineup/taxi/IR moves, best lineup for NBA and NFL via one Hungarian-algorithm solver, waivers, win probability). Unit tested.
- `src/ui.js`, `src/view.js`, `src/matchup.js`, `src/waivers.js`, `src/optimize.js` (NBA Optimize lineup dialog), `src/nfl.js` (NFL Optimize lineup dialog and button), `src/card.js` (player card), `src/whatif.js` (the corner What-if scoring control): pure state -> HTML render functions.
- `src/content.js`: one session per league (survives tab switches), data loading, saves, events. NFL leagues get `mountNfl` instead: the OPTIMIZE button and its dialog, nothing else. Renders into a shadow root that replaces Sleeper's "not yet available" placeholder; dialogs render in a separate page-level host.
- `src/page-hook.js`: reads React props off Sleeper's W/ADD buttons and Players/Trend player rows, and hands clicks to the extension via `snp:player-action` / `snp:player-card` DOM events, only for leagues the extension marked NBA (`html[data-snp-nba-league]`). For NFL it reads the Team tab's lineup from Sleeper's Team component (`snp:nfl-lineup-request`) and saves through that component's own `updateMatchupLeg` (`snp:nfl-lineup-save`). On the NBA Players tab it adds the `adminFPTS` and `adminDelta` columns to Sleeper's table component, asking the extension for the what-if scores and rank shifts (`snp:admin-score-request`).
- `src/panel.css`: all styles, inlined into each shadow root.
- `test/unit` (node:test, `TZ=America/New_York`), `test/e2e/panel.test.js` (stand-in Sleeper pages, live public API, mocked authenticated GraphQL). Each e2e run also writes `test-results/e2e.tap`; read it when a run fails intermittently.

## Conventions and gotchas

- Read league rules from the API (`league.settings`, `scoring_settings`); never hardcode them.
- What-if scoring and the adminFPTS/adminDelta columns are admin tools, off unless `?snp-admin=1` was seen (saved in `chrome.storage.local`, key `admin`).
- Score fantasy points with `ui.scoringOf(state)`, never `league.scoring_settings` directly, so what-if scoring reaches them. Sleeper's own totals use league scoring; set them aside when `ui.whatIfOn(state)`.
- Port behavior from Sleeper's own web bundle when it exists (mutation shapes, eligibility, dialog wording) instead of inventing it.
- Logged-in calls send `localStorage.token` as `Authorization`; never log or render it.
- Public `/v1/league/<id>/rosters` is CDN-cached for minutes; when logged in read rosters via GraphQL `league_rosters`.
- In season, lineups live on the week's matchup leg (`update_matchup_leg`); outside it, `roster_update_starters`.
- Save order: taxi before starters; a starter going to IR leaves the lineup, then IR saves, then the final lineup.
- Nothing renders until the first league + week load is done, so the user never sees a half-built panel or Sleeper's placeholder.
- Writing style: no em-dashes; one sentence per line in long Markdown.
