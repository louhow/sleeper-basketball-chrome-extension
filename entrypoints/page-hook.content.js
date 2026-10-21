import { defineContentScript } from 'wxt/utils/define-content-script';
import { hookPage } from '../src/page-hook.js';

// Runs in the page's own world, where React props on Sleeper's elements are readable.
export default defineContentScript({
  matches: ['https://sleeper.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    hookPage();
  },
});
