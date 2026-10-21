import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODULES } from './load.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

// content.js and page-hook.js need a browser to run, but every file must at least parse.
test('every extension script parses', () => {
  const files = [...readdirSync(`${root}src`).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ...readdirSync(`${root}entrypoints`).map((f) => `entrypoints/${f}`)];
  for (const file of files) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' }), file);
  }
});

test('the content script loads every module', () => {
  const loaded = new Set(MODULES);
  const missing = readdirSync(`${root}src`)
    .filter((f) => f.endsWith('.js') && !['content.js', 'page-hook.js'].includes(f) && !loaded.has(`src/${f}`));
  assert.deepEqual(missing, []);
});
