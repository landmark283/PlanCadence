/**
 * 样式探针：读页面里某个文本的真实计算样式。
 *
 * 为什么需要它：截图只能看到「看起来发暗」，无法区分是配色真的错了、
 * 还是拍在了淡入动画中途。肉眼判断不了的事就量出来。
 *
 * 用法：
 *   node .dev/probe.mjs --dist apps/mobile/dist --routes / --text 今日 --scheme dark
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
const target = arg('text', '今日');
const scheme = arg('scheme', 'dark');
/** 裁切区域 WxHxY。原图会被预览缩放到 ~543 宽，1x 裁切才能看清笔画 */
const clipArg = arg('clip', null);
const dsf = Number(arg('dsf', '3'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

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
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: dsf, colorScheme: scheme });
const page = await ctx.newPage();
await page.goto(`${base}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(Number(arg('settle', '3000')));

const report = await page.evaluate((needle) => {
  const hits = [...document.querySelectorAll('div,span,p')].filter(
    (e) => e.textContent?.trim() === needle && e.children.length === 0,
  );
  const describe = (el) => {
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 60),
      color: cs.color,
      // color 可以被 -webkit-text-fill-color 覆盖，而 getComputedStyle().color 不会反映出来
      fill: cs.webkitTextFillColor,
      opacity: cs.opacity,
      filter: cs.filter,
      mixBlendMode: cs.mixBlendMode,
      textShadow: cs.textShadow,
      zIndex: cs.zIndex,
      position: cs.position,
    };
  };
  return {
    matches: hits.map((e) => {
      const r = e.getBoundingClientRect();
      const cx = Math.round(r.left + 20);
      const cy = Math.round(r.top + r.height / 2);
      const onTop = document.elementFromPoint(cx, cy);
      const chain = [];
      let n = e.parentElement;
      while (n && n !== document.documentElement) {
        chain.push(describe(n));
        n = n.parentElement;
      }
      return {
        self: describe(e),
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
        // 该点最上层是谁——若不是自己或自己的后代，说明被盖住了
        onTop: onTop ? { ...describe(onTop), isSelfOrDescendant: onTop === e || e.contains(onTop) } : null,
        ancestors: chain,
      };
    }),
  };
}, target);

console.log(JSON.stringify(report, null, 2));

const outName = clipArg ? `crop-${scheme}.png` : `probe-${scheme}.png`;
await page.screenshot({
  path: path.join(WORKSPACE, 'outputs/screenshots', outName),
  ...(clipArg
    ? (() => {
        const [w, h, y] = clipArg.split('x').map(Number);
        return { clip: { x: 0, y: y ?? 0, width: w, height: h } };
      })()
    : {}),
});
await browser.close();
server.close();
