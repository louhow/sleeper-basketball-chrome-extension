import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// content.js and page-hook.js need a browser to run, but they must at least compile.
test('every extension script compiles', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
  for (const file of manifest.content_scripts.flatMap((c) => c.js)) {
    assert.doesNotThrow(() => new vm.Script(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), { filename: file }), file);
  }
});
