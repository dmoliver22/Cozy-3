// Builds two self-contained pages from the same source:
//   dist-single/suds-and-snips.html  a complete HTML document (open it straight from disk)
//   dist-single/artifact.html        the same page as a body fragment, for hosts that wrap pages
// three.js is loaded from jsDelivr through an import map; everything else is inlined.
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'node_modules/three/package.json'), 'utf8'));
const THREE_VERSION = pkg.version;
const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;

const result = await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  write: false,
  outdir: path.join(root, 'dist-single/tmp'),
  external: ['three', 'three/*'],
  loader: { '.css': 'css' },
  legalComments: 'none',
});

let js = '', css = '';
for (const f of result.outputFiles) {
  if (f.path.endsWith('.js')) js += f.text;
  else if (f.path.endsWith('.css')) css += f.text;
}
js = js.replace(/<\/script/gi, '<\\/script');

const html = await readFile(path.join(root, 'index.html'), 'utf8');
const app = html.slice(html.indexOf('<!-- APP:START -->'), html.indexOf('<!-- APP:END -->') + '<!-- APP:END -->'.length);
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];
const importMap = JSON.stringify({ imports: { three: `${CDN}/build/three.module.js`, 'three/examples/jsm/': `${CDN}/examples/jsm/` } });

const headBits = `<title>Suds &amp; Snips</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
${fonts}
<style>${css}</style>`;
const bodyBits = `${app}
<script type="importmap">${importMap}</script>
<script type="module">${js}</script>`;

const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
${headBits}
</head>
<body>
${bodyBits}
</body>
</html>
`;
const fragment = `${headBits}\n${bodyBits}\n`;

await mkdir(path.join(root, 'dist-single'), { recursive: true });
await writeFile(path.join(root, 'dist-single/suds-and-snips.html'), full);
await writeFile(path.join(root, 'dist-single/artifact.html'), fragment);
console.log(`dist-single/suds-and-snips.html  ${(full.length / 1024).toFixed(0)} kB (three ${THREE_VERSION} from jsDelivr)`);
console.log(`dist-single/artifact.html        ${(fragment.length / 1024).toFixed(0)} kB`);
