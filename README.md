# Sleeper EPL Chrome Extension

Chrome extension (Manifest V3) that fills Sleeper's empty web page for Premier League fantasy leagues (`sleeper.com/leagues/<id>`, which only says "Fantasy CLUBSOCCER:EPL not supported on web yet") with the mobile app's four tabs:

- **Match**: your matchup for the week, win probability, points and projections, starters side by side by slot, then bench and injured reserve.
- **Team**: your lineup with formation (3-4-3 and so on), each player's next match, projected and actual points, start and rostered percentages. Tap a position badge, then a highlighted player, to swap them. Move injured players to IR. An Optimize button proposes the best projected lineup and saves it once you confirm.
- **Players**: available players, trending adds and drops, season leaders, your team, and search, filtered by position. Add free agents, place waiver bids (with FAAB) and drop players, with the same roster and budget checks Sleeper's own dialog makes.
- **League**: every matchup this week, the standings table and the week's transactions.

Clicking any player opens a card like the app's: bio, next match, projections for the coming gameweeks, news, a per-match game log with heat-shaded stats, career totals and the player's transaction history in your league.

There is also an API tab that logs every call the extension makes, with timing, size and a JSON preview, for debugging.

It follows the design of [louhow/sleeper-basketball-chrome-extension](https://github.com/louhow/sleeper-basketball-chrome-extension), which does the same for NBA leagues.

Unofficial and not affiliated with Sleeper. It uses the same endpoints as Sleeper's own apps, which can change without notice.

## Privacy

Everything runs locally in your browser. There is no server: the extension only talks to Sleeper, the same way Sleeper's own site does. It calls `api.sleeper.app` and `sleeper.com/graphql` for league data, and loads headshots, club logos and avatars from `sleepercdn.com`.

Logged-in calls (your lineup, adds, drops, bids) send the session token Sleeper's website keeps in `localStorage`, as the `Authorization` header, exactly as Sleeper's web app does. The token is never stored, logged or shown. The only things the extension stores are a cached copy of Sleeper's public EPL player list (12 hours) and which team you last viewed per league, both in your browser's extension storage.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this directory.
4. Log in at `https://sleeper.com` and open your EPL league: `https://sleeper.com/leagues/<league id>`.

The panel replaces the "not supported on web yet" placeholder. It only mounts for `clubsoccer:epl` leagues; other sports are left alone. If Sleeper's page has no placeholder to fill, it opens as a floating panel instead.

To update after pulling changes, hit the reload icon on the extension's card at `chrome://extensions` and refresh the Sleeper tab.

## How it works

- `manifest.json`: content scripts run at `document_start` on `sleeper.com`, in this order: `scoring`, `model`, `api`, `ui`, `team`, `matchup`, `league`, `players`, `card`, `dialogs`, `view`, `content`.
- `src/scoring.js`: fantasy points from a Sleeper soccer stat line. Soccer scoring is keyed by position and stat (`pos_m_g` is a midfielder's goals) and Sleeper's stat rows carry the same keys, so points are a weighted sum. Checked against Sleeper's own `pts_std` for standard-scoring leagues.
- `src/model.js`: pure rules. Matches per gameweek (a club can play twice), weekly totals, which positions each slot accepts (`FM_FLEX` takes F or M, and so on), lineup and IR moves, formations, a Hungarian-algorithm lineup optimizer, Sleeper's win-probability formula, standings, FAAB and roster-room checks for claims, and a best guess at waiver status.
- `src/ui.js`: shared render helpers and the resolved lineup for a roster and week.
- `src/team.js`, `src/matchup.js`, `src/league.js`, `src/players.js`, `src/card.js`, `src/dialogs.js`, `src/view.js`: pure state -> HTML render functions.
- `src/content.js`: one session per league (survives Sleeper's in-page navigation), data loading, saves and events. Renders into a shadow root in place of Sleeper's placeholder; dialogs render in a separate page-level host.
- `src/panel.css`: all styles, inlined into each shadow root.

### Formations

Sleeper's soccer lineups have fixed slots (F, M, M, M, D, D, D, GK in this league) plus flex slots (`FM_FLEX`, `MD_FLEX`, `FMD_FLEX`). The app shows that as a formation such as 3-4-3 and saves the choice in the roster's metadata. The extension labels each flex slot to match the saved formation for the week when there is one, else by the player in it, and shows the resulting formation next to the lineup. Any player a flex slot accepts can be moved into it; the formation changes with the players you pick.

### API calls

| Call | Used for |
| --- | --- |
| `GET /v1/league/<id>`, `/users`, `/rosters`, `/transactions/<week>` | League settings and scoring, team names, rosters, the week's moves |
| `GET /v1/state/clubsoccer:epl` | Current gameweek |
| `GET /v1/players/clubsoccer:epl` | Names, clubs, positions, injuries (~2.3 MB, cached 12h) |
| `GET /schedule/clubsoccer:epl/regular/<season>` | Every gameweek's fixtures (last week of the season, fallback for kickoff data) |
| `GET /projections/clubsoccer:epl/<season>/<week>`, `/stats/...` | Per-match projected and actual stats, scored with the league's settings |
| `GET /players/clubsoccer:epl/research/regular/<season>/<week>` | Rostered and start percentages |
| `GET /v1/players/clubsoccer:epl/trending/add`, `/drop` | Trending players |
| `GET /stats/clubsoccer:epl/<season>` | Season totals for Leaders and the FPTS column |
| `GET /players/clubsoccer:epl/<id>`, `/stats/clubsoccer:epl/player/<id>?grouping=week`, `/projections/...` | Player card: bio, game log, career |
| `POST sleeper.com/graphql` `scores`, `roster_standings`, `get_player_news` | Kickoff times and match status, standings rank, news |
| `POST sleeper.com/graphql` (logged in) `me`, `league_rosters`, `matchup_legs`, `league_transactions_filtered`, `league_transactions_by_player` | Who you are, live rosters, matchup pairings and Sleeper's own points, pending claims, player history |
| `POST sleeper.com/graphql` (logged in) `update_matchup_leg`, `roster_update_starters`, `roster_update_reserve` | Saving a lineup (in season it lives on the week's matchup leg) and IR moves |
| `POST sleeper.com/graphql` (logged in) `league_create_transaction`, `submit_waiver_claim`, `update_waiver_claim`, `cancel_waiver_claim` | Adds, drops, waiver bids and pending claims |

Sleeper's public `/v1/league/<id>/matchups/<week>` endpoint answers 404 for EPL leagues, so matchup pairings and Sleeper's own weekly totals come from the logged-in `matchup_legs` query. Logged out, the Match and League tabs show lineups but no pairings.

## Known limits

- The formation picker in the app (4-5-1, 3-4-3, ...) isn't reproduced as a control; the formation follows the players you put in the flex slots.
- Whether an unrostered player is on waivers or a free agent is a best guess (dropped within the league's waiver clear days, or their club has kicked off this week). The add dialog lets you switch between a free-agent add and a waiver claim, and Sleeper has the final say.
- Trades are not supported; use the app.
- Stat labels in the game log and card (KP, DRB, and so on) are the extension's reading of Sleeper's stat keys.

## Development

`test/harness.html` is a stand-in for Sleeper's league page. Serve the repository root and open it:

```bash
python3 -m http.server 8123 --bind 127.0.0.1
```

Then visit `http://localhost:8123/test/harness.html` (add `?league=<id>` for another league). Public API calls go to Sleeper live; there is no session, so logged-in features show their logged-out state.

## License

[MIT](LICENSE)
