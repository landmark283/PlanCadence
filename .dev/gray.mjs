/**
 * 灰度图探针：把截图降采样成字符画。
 *
 * 在「DOM 声明」和「截图观感」互相矛盾时用。字符画能一次看清
 * 「哪一块是什么亮度」，比逐点猜快得多。
 *
 * 用法：node .dev/gray.mjs --scheme dark --step 8 --maxY 200
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(WORKSPACE, '.playwright');
}

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const distDir = path.resolve(WORKSPACE, arg('dist', 'apps/mobile/dist'));
const route = arg('routes', '/');
const scheme = arg('scheme', 'dark');
const step = Number(arg('step', '8'));
const maxY = Number(arg('maxY', '200'));
const W = 375;
const H = 812;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const p of [path.join(distDir, urlPath), path.join(distDir, `${urlPath}.html`), path.join(distDir, urlPath, 'index.html'), path.join(distDir, 'index.html')]) {
      const resolved = path.resolve(p);
      if (!resolved.startsWith(path.resolve(distDir))) continue;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }
    }
    res.writeHead(404).end('nf');
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: scheme });
const page = await ctx.newPage();
await page.goto(`${base}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(Number(arg('settle', '2500')));

const shot = await page.screenshot();
const b64 = shot.toString('base64');

const art = await page.evaluate(
  async ({ b64, step, maxY }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);

    const RAMP = ' .:-=+*#%@'; // 越亮字符越"重"
    const lines = [`image ${img.width}x${img.height}`];
    for (let y = 0; y < Math.min(maxY, img.height); y += step) {
      let line = String(y).padStart(3, ' ') + '|';
      for (let x = 0; x < img.width; x += step) {
        const d = g.getImageData(x, y, 1, 1).data;
        const l = (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255;
        line += RAMP[Math.min(RAMP.length - 1, Math.round(l * (RAMP.length - 1)))];
      }
      lines.push(line);
    }
    // 几个关键点的原始 RGB
    const probe = [];
    for (const [x, y] of [[5, 5], [360, 5], [5, 26], [200, 26], [360, 26], [5, 53], [360, 53], [5, 400]]) {
      const d = g.getImageData(x, y, 1, 1).data;
      probe.push(`(${x},${y}) = ${d[0]},${d[1]},${d[2]}`);
    }
    return { lines, probe };
  },
  { b64, step, maxY },
);

console.log(art.lines.join('\n'));
console.log('\n关键点：');
for (const p of art.probe) console.log('  ' + p);
await browser.close();
server.close();
