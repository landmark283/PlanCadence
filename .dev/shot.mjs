/**
 * 单屏截图 + 元素级度量。比 ui-screenshot 技能那个通用脚本多两件事：
 *
 *  1. **可以先把调试日期注入进去**（`--date 2026-10-19`）。
 *     计划里真正有排期的日子是 10-19 那一周，而真实的今天是 10-04——
 *     不注入的话周条上一条负载条都看不到，前后对比也就比不出什么。
 *     注入的是设备设置（localStorage 里的 `studyplan:settings.json`），
 *     和学生在文件页点「固定日期」是同一个东西，不碰计划文件。
 *
 *  2. **可以按语义裁一张元素图**（`--cells`）。周条的七个格子都是
 *     `role=button` 且 aria-label 形如「19 日，2 项任务」，所以不用给生产代码
 *     加 testID 就能定位到它们，再把七个盒子并起来裁一张——那正好就是周条。
 *     每次都打印每个格子的盒子，所以「抽取组件之后布局漂了没有」是**量出来的**，
 *     不是看出来的。
 *
 * 用法：
 *   node .dev/shot.mjs --out outputs/before --date 2026-10-19 --cells
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
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const distDir = path.resolve(WORKSPACE, arg('dist', 'apps/mobile/dist'));
const outDir = path.resolve(WORKSPACE, arg('out', 'outputs/shot'));
const route = arg('route', '/');
const date = arg('date', null);
const [vw, vh] = arg('viewport', '375x812').split('x').map(Number);
const scheme = arg('scheme', 'light');
/** 截图前先点一下这个无障碍标签。用来验证「按了这个按钮到底会不会动」 */
const click = arg('click', null);
/** 要依次做的动作，用 `|` 分隔。给了它就忽略 --click */
const clickList = (arg('clicks', null) ?? click ?? '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);
/** 长按（毫秒）。作用在**第一步**动作上，用来验证长按入口 */
const hold = arg('hold', null);const clickHoldMs = hold ? Number(hold) : 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** 极简静态服务器：支持 Expo 静态导出（/calendar -> calendar.html） */
function serve(dir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const cand of [
      path.join(dir, urlPath),
      path.join(dir, `${urlPath}.html`),
      path.join(dir, urlPath, 'index.html'),
      path.join(dir, 'index.html'),
    ]) {
      const resolved = path.resolve(cand);
      if (!resolved.startsWith(path.resolve(dir))) continue;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

if (!fs.existsSync(distDir)) {
  console.error(`找不到构建产物：${distDir}`);
  process.exit(1);
}

const server = await serve(distDir);
const base = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, colorScheme: scheme });

if (date) {
  // 必须在页面脚本之前写入，否则启动时读到的是默认设置
  await ctx.addInitScript((d) => {
    localStorage.setItem(
      'studyplan:settings.json',
      JSON.stringify({ clock: { mode: 'debug', date: d }, lastSeen: d }, null, 2)
    );
  }, date);
}

const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${base}${route}`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(900);

/**
 * 依次做几个动作。
 *
 * 用无障碍标签定位而不是 CSS：这个项目的可点元素都写了 `accessibilityLabel`
 * （`accessibilityRole="button"`），按标签点等于**同时验证了读屏用户也能找到它**。
 * 找不到就明确报出来——「按钮点了没反应」正是这一轮要根治的那类毛病。
 *
 * 用 `|` 分隔可以串好几步（`--clicks "编辑这一项|打上标记重点|保存"`），
 * 因为「保存真的写回去了吗」这种事一步验不完。`--hold` 作用在**第一步**上
 * （典型的第一步就是「长按卡片进编辑页」）。
 */
if (clickList.length) {
  for (let i = 0; i < clickList.length; i++) {
    const label = clickList[i];
    // 先精确匹配无障碍标签；找不到再退到子串匹配——
    // 任务卡那个标签里带着标题，而标题是动态的，写死整句很脆
    let target = page.locator(`[aria-label="${label}"]`).first();
    if ((await target.count()) === 0) {
      target = page.locator(`[aria-label*="${label}"]`).first();
    }
    /**
     * 等它**可见**再点。
     *
     * 不能只用 `count()` 判断：元素可能已经在 DOM 里但还没显示出来
     * （屏幕切换的淡入、上一屏还挂着、被别的层盖住）。这时候直接点会
     * 以「element is not visible」卡满 30 秒——而这在**多步串联**里必然发生，
     * 因为上一步（点「应用」）会触发导航。
     *
     * 也不能只等一次：调模型要几十秒，目标根本还没渲染出来。
     * 所以这里的等待要同时覆盖「还没出现」和「出现了但不可见」。
     */
    let ready = true;
    try {
      await target.waitFor({ state: 'visible', timeout: Number(arg('click-wait', '240000')) });
    } catch {
      ready = false;
    }
    const n = ready ? 1 : 0;
    if (!n) {
      // 找不到就把页面上所有无障碍标签列出来——省得靠猜标题
      const seen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[aria-label]'))
          .filter((e) =>
            typeof e.checkVisibility === 'function'
              ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : e.offsetParent !== null
          )
          .map((e) => e.getAttribute('aria-label'))
          .slice(0, 60)
      );
      console.log(`  ⚠ 第 ${i + 1} 步找不到 aria-label 为「${label}」的元素`);
      console.log(`    页面上可见的标签：${seen.join(' | ')}`);
      process.exitCode = 3;
      break;
    }
    if (i === 0 && clickHoldMs > 0) {
      const box = await target.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(clickHoldMs);
      await page.mouse.up();
      console.log(`  长按「${label}」${clickHoldMs}ms`);
    } else {
      await target.click();
      console.log(`  点了「${label}」`);
    }
    await page.waitForTimeout(1200);
  }

  /**
   * 点完之后停在哪一屏。
   *
   * **必须只看可见的元素**：底部 tab 的各个屏会同时挂在 DOM 里（未选中的只是隐藏），
   * 所以「页面里有没有这段文字」永远为真——`flow.mjs` 的文件头也记着这条。
   * 第一版这里没过滤可见性，于是点完日历打印出来的还是「今日 / 我的目标」，
   * 看起来像导航失败了，其实只是读到了背后那一屏。
   */
  const headings = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div'))
      .filter(
        (e) =>
          e.children.length === 0 &&
          e.textContent?.trim() &&
          (typeof e.checkVisibility === 'function'
            ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : e.offsetParent !== null)
      )
      .map((e) => e.textContent.trim())
      .slice(0, 6)
  );
  console.log(`  当前可见文字开头：${headings.join(' / ')}`);

  /**
   * 摊开所有**可见**的无障碍标签。
   *
   * 长按卡片应该进编辑页、**且不该顺手把面板也展开**——
   * 两个手势落在同一个 Pressable 上，这正是最容易出错的地方。
   * 面板一展开，它的「编辑「…」」胶囊就会出现在这份清单里；
   * 上一屏在 Stack 里仍然挂着，所以导航之后还读得到。
   *
   * （不用 `aria-expanded`：react-native-web 并没有把
   * `accessibilityState.expanded` 输出成这个属性，读了会是空的。）
   */
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label]'))
      .filter((e) =>
        typeof e.checkVisibility === 'function'
          ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          : e.offsetParent !== null
      )
      .map((e) => e.getAttribute('aria-label'))
      .slice(0, 200)
  );
  console.log(`  可见标签：${labels.join(' | ') || '(无)'}`);
  // 面板展开与否的判据：展开时那张卡的标签会变成「收起「…」的调整」
  const expandedCards = labels.filter((l) => l.startsWith('收起「'));
  console.log(`  处于「收起」（= 已展开）状态的卡片：${expandedCards.length} 个`);
}

/** 截图前先把某个元素滚进视野。用来逐段看长页面（编辑页有五六段） */
const scrollTo = arg('scroll-to', null);

const full = path.join(outDir, 'full.png');

/**
 * 把滚动容器滚到底。
 *
 * `fullPage: true` 在这里**不够**：react-native-web 的 ScrollView 是一个
 * `overflow: auto` 的内层 div，`document.body` 根本不长，所以整页截图只截到
 * 视口那一屏。编辑页的下半截（月历、前置、资料、删除）只能靠这个滚出来。
 *
 * 必须放在「点一下」**之后**——否则长按跳进编辑页，新屏从顶部开始，白滚。
 */
if (flag('scroll-bottom')) {
  const found = await page.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll('*')).filter((e) => {
      const st = getComputedStyle(e);
      return e.scrollHeight > e.clientHeight + 20 && st.overflowY !== 'visible';
    });
    for (const e of scrollers) e.scrollTop = e.scrollHeight;
    return scrollers.length;
  });
  console.log(`  滚到底（找到 ${found} 个滚动容器）`);
  await page.waitForTimeout(600);
}

if (scrollTo) {
  const el = page.locator(`[aria-label*="${scrollTo}"]`).first();
  if ((await el.count()) === 0) console.log(`  ⚠ 找不到「${scrollTo}」，没滚`);
  else {
    await el.scrollIntoViewIfNeeded();
    console.log(`  滚到「${scrollTo}」`);
    await page.waitForTimeout(500);
  }
}

/** 截图前先等这段文字出现（调模型要几十秒，固定等待不够用） */
const waitText = arg('wait-text', null);

if (waitText) {
  const hit = page.getByText(waitText, { exact: false }).first();
  await hit
    .waitFor({ state: 'visible', timeout: 120_000 })
    .then(() => console.log(`  等到「${waitText}」`))
    .catch(() => {
      console.log(`  ⚠ 等「${waitText}」超时（120 秒）`);
      process.exitCode = 3;
    });
}

await page.screenshot({ path: full, fullPage: true });
const bodyH = await page.evaluate(() => document.body.scrollHeight);
console.log(`base=${base}  route=${route}  日期=${date ?? '(真实今天)'}  body=${bodyH}px`);
console.log(`  全页 -> ${path.relative(WORKSPACE, full)}`);

if (flag('cells')) {
  // 周条格子：role=button 且 aria-label 形如「19 日，2 项任务」
  const cells = page.locator('[role="button"][aria-label*=" 项任务"]');
  const n = await cells.count();
  if (!n) {
    console.log('  ⚠ 没找到日程格子');
  } else {
    const boxes = [];
    const rows = [];
    for (let i = 0; i < n; i++) {
      const el = cells.nth(i);
      const box = await el.boundingBox();
      const label = await el.getAttribute('aria-label');
      if (!box) continue;
      boxes.push(box);
      rows.push(`    ${label}  x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`);
    }
    console.log(`  日程格子 ${boxes.length} 个：`);
    for (const r of rows) console.log(r);

    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    const pad = 6;
    const clip = {
      x: Math.max(0, x - pad),
      y: Math.max(0, y - pad),
      width: right - x + pad * 2,
      height: bottom - y + pad * 2,
    };
    console.log(`  并集盒子 => clip ${Math.round(clip.width)}x${Math.round(clip.height)} @ ${Math.round(clip.x)},${Math.round(clip.y)}`);
    const cellsFile = path.join(outDir, 'cells.png');
    await page.screenshot({ path: cellsFile, clip });
    console.log(`  格子图 -> ${path.relative(WORKSPACE, cellsFile)}`);
  }
}

if (problems.length) {
  console.log('\n页面报错（截图仍生成了，但先修这些）：');
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(`  - ${p}`);
  process.exitCode = 2;
} else {
  console.log('  无 console/page 错误。');
}

await browser.close();
server.close();
