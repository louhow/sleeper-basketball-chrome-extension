import { defineConfig } from 'wxt';

export default defineConfig({
  // Every import is written out, so files read the same with or without WXT.
  imports: false,
  manifest: {
    name: 'Sleeper NBA',
    description: "Fills Sleeper's empty NBA Team and Matchup tabs (roster, schedule, projections, lineup swaps, Lock-In) and enables waiver bids and adds, plus a log of every API call it makes.",
    permissions: ['storage'],
    host_permissions: ['https://api.sleeper.app/*'],
  },
  // One stable name, so the README can link to the latest release's download.
  zip: { artifactTemplate: 'sleeper-nba.zip' },
  dev: {
    // Port batch 50030-50039 in ~/Code/louhow/PORTS.md.
    server: { port: 50030, strictPort: true },
  },
  // `npm run dev` doesn't open a browser: load .output/chrome-mv3-dev into your own Chrome once,
  // and it reloads itself on every change.
  webExt: { disabled: true },
});
