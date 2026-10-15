// Fails the build if the first-load download exceeds the budget.
// Everything in dist/ is needed for the first visit in M1 (page, app bundle, hair worker),
// so this sums the Brotli-compressed size of every text asset.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const BUDGET_KB = 300;
const dist = new URL('../dist/', import.meta.url).pathname;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|css|html|svg|json|wasm)$/.test(name)) yield p;
  }
}

let total = 0;
const rows = [];
for (const f of files(dist)) {
  const raw = readFileSync(f);
  const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  total += br;
  rows.push([relative(dist, f), (raw.length / 1024).toFixed(1), (br / 1024).toFixed(1)]);
}
rows.sort((a, b) => Number(b[2]) - Number(a[2]));
console.log('file'.padEnd(40), 'raw KB'.padStart(9), 'brotli KB'.padStart(10));
for (const [f, raw, br] of rows) console.log(f.padEnd(40), raw.padStart(9), br.padStart(10));
const totalKB = total / 1024;
console.log(`\nTotal first load (brotli): ${totalKB.toFixed(1)} KB / budget ${BUDGET_KB} KB`);
if (totalKB > BUDGET_KB) {
  console.error('Over budget.');
  process.exit(1);
}
