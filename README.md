# Sleeper NBA Team

Chrome extension (MV3) that fills Sleeper's empty NBA Team tab (`sleeper.com/leagues/<id>/team`) with the layout from the mobile app.
It also logs every API call it makes, with status, timing, size and a JSON preview, to support probing the API.

## What it shows

- Team card: avatar, record, this week's points, Lock-In projection, opponent.
- Starters, bench, injured reserve and taxi squad, each player with a Monday-Sunday strip of games: projected points (actual once played), opponent, tip-off time.
- Rostered and start percentages, as the mobile app shows them (rounded up, for the league's type).
- Draft picks held, including picks acquired by trade.
- Lineup swaps on your own roster: tap a slot badge, then one of the highlighted players (G takes PG/SG, F takes SF/PF, UTIL and bench take anyone).

The projection follows Lock-In rules: an unlocked player scores their final game of the week, so that game's projection is the default.

## Logged-in features

When the page has a Sleeper session, the extension reads its token from `localStorage.token` and sends it as the `Authorization` header, the same way Sleeper's web app does.
The token is never stored, logged or shown; authenticated calls are tagged `auth` in the API log.
It enables:

- `me`: which roster is yours (swaps are only offered there, for the current and future weeks).
- `matchup_legs(league_id, round)`: the week's saved lineup, Sleeper's own projection (`proj_points`) and Lock-In picks (`starters_games`, shown with a lock).
- `update_matchup_leg(...)` during the season, `roster_update_starters(...)` outside it: saving a swap.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and pick this directory.
3. Visit `https://sleeper.com/leagues/<league id>/team` while logged in.

It only mounts for NBA leagues.
Pick your team in the dropdown once; the choice is remembered per league.
If the page has no empty Team tab to fill, it shows as a floating panel instead.
After editing source files, hit the reload icon on the extension card and refresh the Sleeper tab.

## API calls

| Call | Used for |
| --- | --- |
| `GET /v1/league/<id>` | Name, sport check, slot order, scoring, reserve/taxi slot counts, draft rounds, league type |
| `GET /v1/league/<id>/users`, `/rosters` | Team names, avatars, players, starters, taxi, IR, record |
| `GET /v1/league/<id>/winners_bracket` | Last week of the season |
| `GET /v1/league/<id>/traded_picks`, `/drafts` | Draft picks held |
| `GET /v1/league/<id>/matchups/<week>` | Weekly starters, points, opponent |
| `GET /v1/state/nba` | Current week |
| `GET /v1/players/nba` | Names, teams, positions, injuries (~2.5 MB, cached 12h in `chrome.storage.local`) |
| `GET /projections/nba/<season>/<week>` | Per-game projected stats, scored with the league's settings |
| `GET /stats/nba/<season>/<week>` | Per-game actual stats |
| `GET /players/nba/research/<type>/<season>/<week>?league_type=` | Rostered and start percentages |
| `POST sleeper.com/graphql` `scores(...)` | Game times and home/away |
| `POST sleeper.com/graphql` `me`, `matchup_legs`, `update_matchup_leg`, `roster_update_starters` | Logged-in lineup data and saving swaps (see above) |

## Tests

```sh
npm install
npm test          # unit tests: scoring, data model, rendering
npm run test:e2e  # headless Chromium with the extension loaded
```

Logged-out visitors get redirected away from league pages, so the e2e test serves a stand-in page that mirrors the empty Team tab's markup, and keeps public API calls live.
Authenticated GraphQL calls are answered by a mock in the test, so tests never change a real lineup.
Screenshots land in `test-results/`.
