// Headless smoke test: serves the production build, plays one full appointment through the
// debug hooks (window.__suds) and fails on any page error.
//   npm run build && npm run smoke
// Needs Playwright with a Chromium build (npx playwright install chromium).
import { preview } from 'vite';
import { mkdir } from 'node:fs/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const server = await preview({ preview: { port: 4179, strictPort: false }, logLevel: 'silent' });
const url = server.resolvedUrls.local[0];
const shots = process.env.SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
// Prefer the full Chromium build in new headless mode: the old headless shell balloons in memory
// whenever the page waits on software GL for a while (as it does for the photo), until the
// renderer is killed.
async function launch() {
  if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args });
  try {
    return await chromium.launch({ channel: 'chromium', args });
  } catch {
    return chromium.launch({ args });
  }
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 760, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Fail fast rather than waiting on a dead page.
page.on('crash', () => {
  errors.push('the page crashed');
  browser.close();
});
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

const ev = (fn) => page.evaluate(fn);
// Cards spring in; click straight through rather than waiting for them to settle.
const press = (sel) => page.$eval(sel, (el) => el.click());
const stage = () => ev(() => window.__suds.stage());
async function waitStage(want, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await stage()) === want) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for stage "${want}" (at "${await stage()}")`);
}
async function shot(name) {
  if (!shots) return;
  await ev(() => window.__suds.fast(false));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}/${name}.png`, timeout: 90000 });
  await ev(() => window.__suds.fast(true));
}
const step = (msg) => console.log(`  ✓ ${msg}`);

let ok = false;
try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__suds, null, { timeout: 30000 });
  step('salon loads');
  await press('#btn-start');
  await ev(() => window.__suds.fast(true));
  await waitStage('checkin');
  await shot('ticket');
  step('owner and dog arrive, ticket shows');
  await press('#btn-take');
  await waitStage('bath');
  step('dog walks over and jumps into the tub');
  await ev(`(async () => { const S = window.__suds, d = S.game.dog; S.stand(-1.25, -1.55); await S.use('spray', 3, (t) => S.face(d.torso.pos.x + Math.sin(t * 1.3) * 0.3, d.torso.pos.y, d.torso.pos.z)); })()`);
  const wet = await ev(() => window.__suds.stats().wetAvg);
  if (!(wet > 0.05)) throw new Error(`spraying did not wet the coat (wetAvg ${wet})`);
  step(`sprayer soaks the coat (wet ${(wet * 100).toFixed(0)}%)`);
  await ev(() => window.__suds.wash());
  await waitStage('bathDone', 30000);
  step('squeaky clean');
  await page.keyboard.press('KeyF');
  await waitStage('groom');
  step('dog hops to the drying table');
  await ev(`(async () => { const S = window.__suds, d = S.game.dog; S.stand(1.25, -1.3); await S.use('dryer', 4, (t) => S.face(d.torso.pos.x + Math.sin(t * 1.3) * 0.3, d.torso.pos.y, d.torso.pos.z)); })()`);
  const dry = await ev(() => window.__suds.stats().dry);
  if (!(dry > 0.1)) throw new Error(`dryer did not dry the coat (dry ${dry})`);
  step(`dryer dries the coat (dry ${(dry * 100).toFixed(0)}%)`);
  await ev(() => { window.__suds.dry(); window.__suds.demat(); window.__suds.clip(); window.__suds.lookAt('torso'); });
  await shot('groomed');
  await ev(`window.__suds.use('camera', 0.2)`);
  await waitStage('checkout', 180000);
  await shot('checkout');
  step('photo, hand back and payment');
  await press('#btn-next');
  await waitStage('checkin', 180000);
  step('next appointment arrives');
  ok = errors.length === 0;
} catch (e) {
  errors.push(e.message);
}
await browser.close();
await server.close();
if (errors.length) console.error('\nFailures:\n' + errors.map((e) => `  ✗ ${e}`).join('\n'));
console.log(ok ? '\nSmoke test passed.' : '\nSmoke test failed.');
process.exit(ok ? 0 : 1);
