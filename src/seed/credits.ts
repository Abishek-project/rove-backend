import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { VEHICLES } from './data';
import { creditsMarkdown, loadManifest } from './photos';

/** Writes seed-assets/CREDITS.md from the photo manifest. */
const labels = Object.fromEntries(VEHICLES.map((v) => [v.key, `${v.make} ${v.model} (${v.year})`]));
const out = join(resolve(__dirname, '../../seed-assets'), 'CREDITS.md');
writeFileSync(out, creditsMarkdown(loadManifest(), labels));
console.log(`✓ Wrote ${out}`);
