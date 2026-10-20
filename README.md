# Sleeper Basketball Chrome Extension

Chrome extension (MV3) that fills Sleeper's empty NBA Team and Matchup tabs (`sleeper.com/leagues/<id>/team` and `/matchup`) with the layouts from the mobile app.
It also logs every API call it makes, with status, timing, size and a JSON preview, to support probing the API.

Unofficial and not affiliated with Sleeper.
It uses the same endpoints as Sleeper's web app, which can change without notice.

## Privacy

Everything runs locally in your browser.
There is no server: the extension only talks to Sleeper, the same way Sleeper's own site does.
It calls `api.sleeper.app` and `sleeper.com` for league data, and loads player headshots, team logos and avatars from Sleeper's image CDN (`sleepercdn.com`).
No data is sent to the author or any third party, and we never see your data or your Sleeper login.
The only things it stores are a cached copy of Sleeper's public NBA player list and which team you picked per league, both in your browser's extension storage.

## Install

1. Clone the repo: `git clone https://github.com/louhow/sleeper-basketball-chrome-extension.git`
2. Open `chrome://extensions` and turn on Developer mode.
3. Click "Load unpacked" and pick the cloned directory.
4. Visit `https://sleeper.com/leagues/<league id>/team` while logged in.

It only mounts for NBA leagues.
Pick your team in the dropdown once; the choice is remembered per league.
If the page has no empty Team tab to fill, it shows as a floating panel instead.
To update, `git pull`, hit the reload icon on the extension card, and refresh the Sleeper tab.

See [docs/DETAILS.md](docs/DETAILS.md) for features, the API calls it makes, and tests.

## License

[MIT](LICENSE)
