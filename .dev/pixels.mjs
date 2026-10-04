/**
 * 像素探针：量某一行文字的实际渲染对比度。
 *
 * 为什么必须量像素：DOM 说元素 color 是近白色、opacity 1、没被遮挡，
 * 但截图看起来发暗。当「声明」和「观感」矛盾时，只有像素是事实。
 * 做法是把截图交给浏览器自己的 canvas 解码（Node 侧不必引图像库）。
 *
 * 用法：
 *   node .dev/pixels.mjs --scheme dark --row 26 --x 24 --w 200
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
const W = Number(arg('w', '375'));
const H = Number(arg('h', '812'));

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
// dsf=1 让截图坐标与 CSS 像素一一对应
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: scheme });
const page = await ctx.newPage();
await page.goto(`${base}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(Number(arg('settle', '2500')));

const shot = await page.screenshot();
const b64 = shot.toString('base64');

const rows = arg('rows', '26,53')
  .split(',')
  .map((s) => Number(s.trim()));

const out = await page.evaluate(
  async ({ b64, rows, x0, w }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);

    const lum = ([r, gg, b]) => 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const ratio = (a, b) => (Math.max(a, b) + 5) / (Math.min(a, b) + 5);

    return rows.map((y) => {
      const data = g.getImageData(x0, y, w, 1).data;
      let lightest = [0, 0, 0];
      let darkest = [255, 255, 255];
      const seen = [];
      for (let i = 0; i < w; i++) {
        const p = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
        if (lum(p) > lum(lightest)) lightest = p;
        if (lum(p) < lum(darkest)) darkest = p;
        if (i % 12 === 0) seen.push(p.join(','));
      }
      return {
        y,
        lightest: lightest.join(','),
        darkest: darkest.join(','),
        contrast: Number((ratio(lum(lightest), lum(darkest)) / 1).toFixed(2)),
        sample: seen.join(' | '),
      };
    });
  },
  { b64, rows, x0: Number(arg('x', '24')), w: Number(arg('w2', '220')) },
);

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
