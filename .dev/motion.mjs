/**
 * 动效验证：证明三处动效**真的在动**，而不只是"代码看着对"。
 *
 * 为什么不用静态截图：静态截图只能拍到动画的终点，而终点和「没有动画」
 * 长得一模一样。所以这个脚本在动画**进行中**取样：
 *
 *   1. 勾选任务 → 停 70ms 拍一张 → 停到 600ms 再拍一张。
 *      断言中途的划线不透明度严格介于 0 和 1 之间（正在淡入），
 *      终态为 1；并且划线是「文字透明 + 装饰线有颜色」的副本。
 *   2. 展开面板 → 断言中途高度严格小于终态高度（正在长高），终态 > 0。
 *   3. 进度计数 → 断言中途读到的数字既不是起点也不是终点。
 *
 * 用法：node .dev/motion.mjs [--dist apps/mobile/dist] [--out outputs/motion]
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
const outDir = path.resolve(WORKSPACE, arg('out', 'outputs/motion'));
fs.mkdirSync(outDir, { recursive: true });

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
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const results = [];
const pass = (ok, text) => results.push(`${ok ? '✓' : '✕'} ${text}`);
const shot = (n) => page.screenshot({ path: path.join(outDir, `${n}.png`) });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/* ── 1. 勾选 → 划线淡入 ─────────────────────────────────── */
const checkbox = page.locator('[role="checkbox"]').first();
pass((await checkbox.count()) > 0, '今日页有可勾选的任务');

/** 标题那一层：base 文本 + 一个 aria-hidden 的副本 */
const titleProbe = () =>
  page.evaluate(() => {
    const copy = document.querySelector('[aria-hidden="true"]');
    if (!copy) return null;
    const text = copy.querySelector('span, div') ?? copy;
    const cs = getComputedStyle(text);
    const wrap = copy.parentElement;
    return {
      ariaHidden: copy.getAttribute('aria-hidden'),
      color: cs.color,
      decoration: cs.textDecorationLine,
      decorationColor: cs.textDecorationColor,
      opacity: getComputedStyle(copy).opacity,
      text: (text.textContent ?? '').slice(0, 24),
      wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : 0,
    };
  });

const before = await titleProbe();
pass(before !== null, '标题里有对读屏隐藏的划线副本');
if (before) {
  pass(/rgba?\(0, 0, 0, 0\)|transparent/.test(before.color), `副本文字透明（color=${before.color}）`);
  pass(before.decoration === 'line-through', `副本带删除线（text-decoration-line=${before.decoration}）`);
  pass(!/rgba?\(0, 0, 0, 0\)|transparent/.test(before.decorationColor), `删除线有色（text-decoration-color=${before.decorationColor}）`);
  pass(Number(before.opacity) === 0, `未勾选时划线不可见（opacity=${before.opacity}）`);
}

await checkbox.click();
await page.waitForTimeout(70);
const mid = await titleProbe();
await shot('01-strike-mid');
await page.waitForTimeout(600);
const end = await titleProbe();
await shot('02-strike-done');

if (mid && end) {
  const m = Number(mid.opacity);
  pass(m > 0 && m < 1, `70ms 时划线正在淡入（opacity=${m.toFixed(2)}）`);
  pass(Number(end.opacity) === 1, `终态划线完全可见（opacity=${end.opacity}）`);
  pass(m > 0 && m < 1 && Number(end.opacity) === 1, `划线在动，不是瞬间出现（${m.toFixed(2)} → ${end.opacity}）`);
}

/* ── 2. 展开面板 → 高度从 0 长出来 ───────────────────────── */
const panelProbe = () =>
  page.evaluate(() => {
    // 展开区是「状态」那一行的容器：找一个含「状态」且高度被动画控制的祖先
    const label = [...document.querySelectorAll('div,span')].find((n) => n.textContent?.trim() === '状态');
    let el = label?.parentElement ?? null;
    // 往上找到设了具体高度且 overflow 被裁掉的那一层
    for (let i = 0; i < 6 && el; i++) {
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' && cs.height !== 'auto') return { h: Math.round(parseFloat(cs.height)), opacity: cs.opacity };
      el = el.parentElement;
    }
    return null;
  });

// 打勾后卡片会自动展开，所以这里先收起再展开，才能量到"从 0 长出来"
const adjust = page.getByRole('button', { name: /收起|调整/ }).first();
const adjustLabel = await adjust.getAttribute('aria-label');
if (/收起/.test(adjustLabel ?? '')) {
  await adjust.click();
  await page.waitForTimeout(700);
}
const collapsed = await panelProbe();
pass(collapsed === null || collapsed.h === 0, `收起后面板不可见或高度为 0（${collapsed ? `h=${collapsed.h}` : '已卸载'}）`);

if ((await adjust.getAttribute('aria-label'))?.includes('调整')) {
  await adjust.click();
  await page.waitForTimeout(60);
  const pMid = await panelProbe();
  await shot('03-panel-mid');
  await page.waitForTimeout(700);
  const pEnd = await panelProbe();
  await shot('04-panel-open');
  if (pMid && pEnd) {
    pass(pMid.h < pEnd.h && pEnd.h > 0, `面板正在长高（60ms h=${pMid.h} < 终态 h=${pEnd.h}）`);
  } else {
    pass(false, `没量到面板高度（mid=${JSON.stringify(pMid)} end=${JSON.stringify(pEnd)}）`);
  }
}

/* ── 3. 进度计数滚动 ────────────────────────────────────── *
 * 刻意**取消勾选**而不是再勾一项：取消会把已投入的分钟数从 25 掉回 0，
 * 区间够大，中途能取到 0 和 25 之间的值。
 * 换成 1→0 这种区间为 1 的滚动，中途值只可能是两个端点，
 * 「在滚」和「瞬间跳」就区分不出来。
 */
const counterText = () => page.locator('div').filter({ hasText: /^本周 \d+\/\d+ 项 · \d+\/\d+ 分钟$/ }).first().textContent().catch(() => null);
const minutes = (s) => Number((s?.match(/· (\d+)\//) ?? [])[1]);
const doneNum = (s) => Number((s?.match(/本周 (\d+)\//) ?? [])[1]);

const settled = await counterText();
const firstDone = page.locator('[role="checkbox"]').first();
await firstDone.click();
await page.waitForTimeout(60);
const cMid1 = await counterText();
await page.waitForTimeout(70);
const cMid2 = await counterText();
await page.waitForTimeout(800);
const cEnd = await counterText();
await shot('05-counter');

pass(!!settled && !!cEnd, `读到计数文字（起点=${settled} 终点=${cEnd}）`);
if (settled && cEnd) {
  pass(minutes(cEnd) !== minutes(settled), `取消勾选后分钟数变了（${minutes(settled)} → ${minutes(cEnd)}）`);
  pass(doneNum(cEnd) !== doneNum(settled), `完成项数变了（${doneNum(settled)} → ${doneNum(cEnd)}）`);
  const lo = Math.min(minutes(settled), minutes(cEnd));
  const hi = Math.max(minutes(settled), minutes(cEnd));
  const mids = [minutes(cMid1), minutes(cMid2)];
  /**
   * 只要有**一次**采样落在区间内部，就证明数字是滚过去的。
   * 不能要求每次都落在内部：曲线是强 ease-out，280ms 里前 100ms 就走完大半，
   * 后一次采样很可能已经贴到终点——那不是"跳"，是曲线本该有的样子。
   */
  pass(
    mids.some((v) => v > lo && v < hi),
    `中途采到区间内的值 → 数字在滚而不是跳（60ms=${mids[0]} 130ms=${mids[1]}，区间 ${lo}–${hi}）`,
  );
}

console.log(results.join('\n'));
console.log(`\n截图输出：${path.relative(WORKSPACE, outDir)}`);
console.log(problems.length ? `\n发现 ${problems.length} 个 console/page 错误：\n  ${problems.join('\n  ')}` : '\n无 console/page 错误。');

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
