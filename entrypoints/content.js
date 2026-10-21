import { defineContentScript } from 'wxt/utils/define-content-script';
import css from '../src/panel.css?inline';
// Each module adds itself to globalThis.SNP and may use the ones before it, so
// this order matters (test/unit/load.js reads it from here).
import '../src/scoring.js';
import '../src/model.js';
import '../src/api.js';
import '../src/ui.js';
import '../src/view.js';
import '../src/matchup.js';
import '../src/waivers.js';
import '../src/optimize.js';
import '../src/card.js';
import { start } from '../src/content.js';

export default defineContentScript({
  matches: ['https://sleeper.com/*'],
  // At document_start, so the panel can hide Sleeper's placeholder before it paints.
  runAt: 'document_start',
  main() {
    start(css);
  },
});
