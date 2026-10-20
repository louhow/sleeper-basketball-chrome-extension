# Details

How the extension works: what it shows, the Sleeper API calls it makes, and how to run the tests.

## What it shows

### Team

- Team card: avatar, record, this week's points, Lock-In projection, opponent.
- Starters, bench, injured reserve and taxi squad, each player with a Monday-Sunday strip of games: projected points (actual once played), opponent, tip-off time.
- Rostered and start percentages, as the mobile app shows them (rounded up, for the league's type).
- Draft picks held, including picks acquired by trade.
- Lineup swaps on your own roster: tap a slot badge, then one of the highlighted players (G takes PG/SG, F takes SF/PF, UTIL and bench take anyone).
- Taxi moves on your own roster, following the league's taxi settings (see below). Only badges with a legal move are clickable.

#### Taxi rules

These are ported from Sleeper's web app and match its help article:

- Eligibility: with `taxi_allow_vets`, players with `years_exp <= taxi_years` (0 = no limit); otherwise rookies only.
- Moving onto taxi (from the bench or a starting slot, or trading places with a taxi player) is allowed until `taxi_deadline`: through that preseason week, or with 4, until the first regular-season game tips off; 0 means no deadline.
- After the deadline taxi is one-way: a taxi player can only move into an open bench spot, which needs room on the active roster (one player per roster position).
- Taxi is a roster setting, not a weekly one, so it's edited from the current week.

The projection follows Lock-In rules: an unlocked player scores their final game of the week, so that game's projection is the default.

### Matchup

- Both teams side by side: points, projection, win probability, record and standings rank, and how many starters are yet to play.
- Each starter against the opposing starter in the same slot, then bench, IR and taxi.
- Per player: the game that matters for Lock-In (the locked game, the one that can be locked, or the next one), its points or projection, and team logos for the week's games.
- Lock-In for your own starters: once a game ends, `LOCK-IN` stays open until that player's next game starts. Locking is final, so it asks to confirm.

Win probability is Sleeper's own formula, ported from its web app: each side is a normal distribution centred on its projection, narrowing as the score approaches it.
Rank comes from `roster_standings`; before any games are played, it falls back to the standings order (record, points, then waiver order), which is what Sleeper shows then.

## Logged-in features

When the page has a Sleeper session, the extension reads its token from `localStorage.token` and sends it as the `Authorization` header, the same way Sleeper's web app does.
The token is never stored, logged or shown; authenticated calls are tagged `auth` in the API log.
It enables:

- `league_rosters(league_id)`: rosters straight from Sleeper. The public `/rosters` endpoint is cached at the CDN for up to ~10 minutes, so after a save it can show (and a follow-up move could build on) the old roster.
- `me`: which roster is yours (swaps are only offered there, for the current and future weeks).
- `matchup_legs(league_id, round)`: the week's saved lineup, Sleeper's own projection (`proj_points`) and Lock-In picks (`starters_games`, shown with a lock).
- `update_matchup_leg(...)` during the season, `roster_update_starters(...)` outside it: saving a swap.
- `update_matchup_leg(..., starters_games: $starters_games)`: Lock-In. The variable is the week's full player -> game map as JSON, with the new lock added.
- `roster_update_taxi(league_id, roster_id, taxi)`: taxi moves. Saved before any starter change, like Sleeper's web app.

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
| `POST sleeper.com/graphql` `roster_standings(...)` | Standings rank |
| `POST sleeper.com/graphql` `me`, `matchup_legs`, `update_matchup_leg`, `roster_update_starters`, `roster_update_taxi` | Logged-in lineup data, swaps, Lock-In and taxi (see above) |

## Tests

```sh
npm install
npm test          # unit tests: scoring, data model, rendering
npm run test:e2e  # headless Chromium with the extension loaded
```

Logged-out visitors get redirected away from league pages, so the e2e test serves a stand-in page that mirrors the empty Team tab's markup, and keeps public API calls live.
Authenticated GraphQL calls are answered by a mock in the test, so tests never change a real lineup.
The Lock-In test fakes a mid-week state (each team's first game finished, projections standing in for stats), since nothing is lockable before games are played.
Screenshots land in `test-results/`.
