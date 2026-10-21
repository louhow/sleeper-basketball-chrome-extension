// Loads the extension's modules into a fresh VM context, in the order the
// content script entrypoint imports them (content.js itself needs a browser).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const entry = readFileSync(new URL('../../entrypoints/content.js', import.meta.url), 'utf8');
export const MODULES = [...entry.matchAll(/^import '\.\.\/(src\/[\w-]+\.js)';$/gm)].map((m) => m[1]);

export function loadSnp() {
  const context = vm.createContext({});
  for (const file of MODULES) {
    vm.runInContext(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  return context.SNP;
}
