// Loads the extension's content scripts into a fresh VM context, in manifest order.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

export function loadSnp() {
  const context = vm.createContext({});
  for (const file of manifest.content_scripts[0].js) {
    if (file.endsWith('content.js')) continue;
    vm.runInContext(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  return context.SNP;
}
