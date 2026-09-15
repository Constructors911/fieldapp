import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const shotsDir = join(root, 'onboarding-shots');
const srcHtml = join(root, 'crew-onboarding-deck.html');

let html = readFileSync(srcHtml, 'utf8');
const files = readdirSync(shotsDir).filter((f) => f.endsWith('.png') && !f.startsWith('_'));
const map = {};
for (const file of files) {
  const b64 = readFileSync(join(shotsDir, file)).toString('base64');
  map[`onboarding-shots/${file}`] = `data:image/png;base64,${b64}`;
}

html = html.replace(/onboarding-shots\/[A-Za-z0-9._-]+\.png/g, (path) => {
  if (!map[path]) throw new Error(`Missing image for ${path}`);
  return map[path];
});

const outFile = join(root, 'C911-Field-crew-onboarding.html');
writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${Math.round(html.length / 1024)} KB)`);

const publicDir = join(root, '..', 'web', 'public', 'training');
mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, 'index.html'), html);
console.log('also wrote web/public/training/index.html (self-contained)');
