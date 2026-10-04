/**
 * 对 Expo Web 构建产物做确定性截屏。
 *
 * 为什么不用 runsight 之类的「AI 自主探索」工具：
 * 那条路需要视觉模型 API Key，且每次走的路径不同——无法做前后对比。
 * UI 迭代真正需要的是「同样四个屏、同样视口、每次都一样」，才能一眼看出改坏了什么。
 *
 * 用法:
 *   node <SKILL_BASE>/scripts/shoot.mjs \
 *     --dist apps/mobile/dist \
 *     --out  outputs/screenshots \
 *     --routes /,/explore
 *
 * 选项:
 *   --dist    静态构建产物目录（先用 `pnpm --filter @sp/mobile exec expo export --platform web` 生成）
 *   --out     截图输出目录（默认 outputs/screenshots）
 *   --routes  逗号分隔的路由，默认 /
 *   --viewport WxH，默认 375x812（iPhone 竖屏，与演示机型一致）
 *   --url     直接用已在运行的 dev server（给了它就不启内置静态服务器）
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '../../../..');

// playwright 在 import 时读取该变量，所以必须在动态 import 之前设置。
// 浏览器装在仓库内可避免污染全局缓存，也便于清理。
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(WORKSPACE, '.playwright');
}

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const distDir = path.resolve(WORKSPACE, arg('dist', 'apps/mobile/dist'));
const outDir = path.resolve(WORKSPACE, arg('out', 'outputs/screenshots'));
const routes = arg('routes', '/').split(',').map((r) => r.trim()).filter(Boolean);
const explicitUrl = arg('url', null);
const [vw, vh] = arg('viewport', '375x812').split('x').map(Number);
/**
 * 配色方案。默认只出 light——显式指定时（单个或 `light,dark`）文件名会带后缀，
 * 因为「深色下好看、浅色下崩」是移动端最常见的翻车方式，必须两种都看。
 */
const schemes = arg('scheme', 'light').split(',').map((s) => s.trim());
const suffix = schemes.length > 1 || schemes[0] === 'dark';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** 极简静态服务器：支持 Expo 静态导出（/explore -> explore.html） */
function serve(dir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const candidates = [
      path.join(dir, urlPath),
      path.join(dir, `${urlPath}.html`),
      path.join(dir, urlPath, 'index.html'),
      path.join(dir, 'index.html'),
    ];
    for (const p of candidates) {
      const resolved = path.resolve(p);
      if (!resolved.startsWith(path.resolve(dir))) continue; // 防目录穿越
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

if (!explicitUrl && !fs.existsSync(distDir)) {
  console.error(`找不到构建产物：${distDir}`);
  console.error('先运行：pnpm --filter @sp/mobile exec expo export --platform web');
  process.exit(1);
}

const server = explicitUrl ? null : await serve(distDir);
const base = explicitUrl ?? `http://127.0.0.1:${server.address().port}`;

fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import('playwright');
const browser = await chromium.launch();

console.log(`base=${base}  viewport=${vw}x${vh}  scheme=${schemes.join('+')}`);

for (const scheme of schemes) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  for (const route of routes) {
    const url = `${base}${route}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    // 等 Reanimated / 字体等异步渲染稳定
    await page.waitForTimeout(700);
    const baseName = route === '/' ? 'index' : route.replace(/^\//, '').replace(/\//g, '_');
    const name = suffix ? `${baseName}.${scheme}` : baseName;
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const h = await page.evaluate(() => document.body.scrollHeight);
    console.log(`  [${scheme}] ${route} -> ${path.relative(WORKSPACE, file)}  (body 高度 ${h}px)`);
  }

  if (problems.length) {
    console.log(`\n[${scheme}] 页面报错（截图仍然生成了，但请先修这些）：`);
    for (const p of [...new Set(problems)].slice(0, 20)) console.log(`  - ${p}`);
    process.exitCode = 2;
  }
  await ctx.close();
}

await browser.close();
server?.close();

if (process.exitCode !== 2) console.log('\n无 console/page 错误。');
