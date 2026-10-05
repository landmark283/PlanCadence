/**
 * 一次性排查脚本：「调整」按钮到底有没有用。
 *
 * 存在的理由：flow.mjs 从来没点过这个按钮——它是靠**打勾自动展开**那条路
 * 走到「实际用时」的。所以这个按钮从上线起就没有任何自动化覆盖，
 * 报障之后必须先证明它到底是「点不开」还是「点开了但改不动」。
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(WORKSPACE, '.playwright');
}
const distDir = path.resolve(WORKSPACE, 'apps/mobile/dist');
const outDir = path.resolve(WORKSPACE, 'outputs/screenshots/probe');
fs.mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
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
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage();

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: 'networkidle' });
await page.getByText('我的目标').first().waitFor({ state: 'visible', timeout: 15_000 });

const adjust = page.locator('[aria-label^="调整「"]').first();
const label = await adjust.getAttribute('aria-label');
console.log('找到按钮：', label);

// 按钮的实际盒模型：如果它比手指小很多，那「按了没反应」就是纯粹的触控问题
const box = await adjust.boundingBox();
console.log('按钮盒：', JSON.stringify(box));

await adjust.click();
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(outDir, 'a-after-click.png') });

const panelVisible = await page.getByText('状态', { exact: true }).first().isVisible().catch(() => false);
const afterLabel = await page.locator('[aria-label^="收起「"]').count();
console.log('点后出现「状态」行：', panelVisible, '｜出现「收起」按钮数：', afterLabel);

if (panelVisible) {
  // 面板开了，再试「改一个状态」这条命令链有没有真的落到计划上
  const before = await page.locator('[aria-label^="调整「"]').first().getAttribute('aria-label').catch(() => '');
  const chip = page.getByRole('button', { name: '进行中' }).first();
  const n = await chip.count();
  console.log('「进行中」胶囊数：', n);
  if (n) {
    await chip.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, 'b-after-status.png') });
    const notice = await page.getByText(/已更新|无法|失败|不能/).first().textContent().catch(() => '(没有通知)');
    console.log('命令反馈：', notice);
  }
}

console.log('控制台错误：', problems.length ? problems : '无');
await browser.close();
server.close();
