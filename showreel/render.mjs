// Renderiza fotogramas de reel.html con Chromium headless (WebGL2 vía SwiftShader).
// Uso: node render.mjs <outDir> [--frames=0-239 | --frames=0,30,60] [--sub=8] [--workers=2]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || 'frames';
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const spec = arg('frames', '0-239'), sub = +arg('sub', '8'), workers = +arg('workers', '2');
const frames = spec.split(',').flatMap(p => { const [a, b = a] = p.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i); });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-vsync'] });
const queue = [...frames]; const t0 = Date.now(); let done = 0;
async function worker(id) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', m => console.log(`[w${id}]`, m.text()));
  page.setDefaultTimeout(0);
  page.on('pageerror', e => { console.error(`[w${id}] pageerror`, e.message); process.exit(1); });
  await page.goto('file://' + path.join(here, 'reel.html'));
  await page.evaluate(() => window.READY);
  while (queue.length) {
    const f = queue.shift();
    const file = path.join(outDir, `f${String(f).padStart(4, '0')}.png`);
    if (existsSync(file) && !process.argv.includes('--force')) { done++; continue; }   // reanudable
    await page.evaluate(([f, s]) => window.renderFrame(f, s), [f, sub]);
    // captura de página sin timeout: con SwiftShader el raymarch puede tener la GPU ocupada >30 s
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 }, timeout: 0 });
    writeFileSync(file, png);
    done++;
    if (done % 10 === 0 || done === frames.length) console.log(`${done}/${frames.length}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  await page.close();
}
await Promise.all(Array.from({ length: Math.min(workers, frames.length) }, (_, i) => worker(i)));
await browser.close();
