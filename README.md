# Sleeper Extension

Chrome extension (MV3) that fills in what Sleeper's website leaves out, across sports.
Unofficial and not affiliated with Sleeper.
It uses the same endpoints as Sleeper's own apps, which can change without notice.

## Features

**NBA**
- Team tab: roster, weekly game strips, projections, lineup swaps, Lock-In, taxi and IR moves, draft picks.
- Matchup tab: both lineups slot by slot, win probability, Lock-In status.
- Optimize lineup: proposes the best starters for the week and saves once you confirm.
- Waiver bids and free-agent adds from Sleeper's own W and ADD buttons, plus your pending claims.
- Player card: bio, game logs, career, news, transaction history.
- Admin tools (off unless `?snp-admin=1`): what-if scoring on the Team and Matchup tabs and player card, adminFPTS and adminDelta columns on the Players tab.

**NFL**
- Optimize lineup button on Sleeper's own Team tab.

**Premier League (EPL)**
- Match, Team, Players and League tabs in place of Sleeper's "not supported on web yet" page.
- Lineup swaps with formations, IR moves, Optimize lineup.
- Free-agent adds, waiver bids and drops.
- Player card with next match, projections, game log, career and history.

**All sports**
- API tab: a log of every call the extension makes, with status, timing, size and a JSON preview.

Details: [docs/DETAILS.md](docs/DETAILS.md) (NBA and NFL) and [docs/EPL.md](docs/EPL.md) (Premier League).

## Privacy

Everything runs locally in your browser.
There is no server: the extension only talks to Sleeper, the same way Sleeper's own site does.
It calls `api.sleeper.app` and `sleeper.com` for league data, and loads player headshots, team logos and avatars from Sleeper's image CDN (`sleepercdn.com`).
No data is sent to the author or any third party, and we never see your data or your Sleeper login.
The only things it stores are cached copies of Sleeper's public player lists and which team you picked per league, both in your browser's extension storage.

## Install

1. Clone the repo: `git clone https://github.com/louhow/sleeper-basketball-extension.git`
2. Open `chrome://extensions` and turn on Developer mode.
3. Click "Load unpacked" and pick the cloned directory.
4. Visit your league on `https://sleeper.com` while logged in (for NBA, the `/team` or `/matchup` tab).

Pick your team in the dropdown once; the choice is remembered per league.
If the page has no empty tab to fill, the panel shows as a floating panel instead.
To update, `git pull`, hit the reload icon on the extension card, and refresh the Sleeper tab.

## License

[MIT](LICENSE)
