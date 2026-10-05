/**
 * 端到端流程验证：访谈 → 生成计划 → 打勾报时 → 复盘。
 *
 * 为什么截图不够：静态截图只能证明「某一屏渲染出来了」，
 * 证明不了「点下去真的会走到下一步」。而参赛要求里明确有一条
 * 「能够跑通的流程」——那就得真的点一遍。
 *
 * 走完整条主线，并在每一步**验证状态真的变了**（而不是只看到画面变了）：
 *   1. 记录初始计划版本
 *   2. 逐题作答（覆盖单选/多选/档位/日期/日期区间/文本六种控件）
 *   3. 点「生成计划」→ 断言版本回到 v1、目标变成访谈里说的那句
 *   4. 打勾一项并报实际用时 → 断言复盘页能识别出偏差
 *
 * 用法：node .dev/flow.mjs [--scheme light] [--out outputs/screenshots/flow]
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
const outDir = path.resolve(WORKSPACE, arg('out', 'outputs/screenshots/flow'));
const scheme = arg('scheme', 'light');

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

fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import('playwright');
const browser = await chromium.launch();
// acceptDownloads 默认是开的，这里写出来是因为后面要**真的接住导出文件**
const ctx = await browser.newContext({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  colorScheme: scheme,
  acceptDownloads: true,
});
const page = await ctx.newPage();

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const log = [];
const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const planMeta = () => page.locator('div').filter({ hasText: /计划 v\d+/ }).first().textContent().catch(() => '(没读到)');
/** 从顶栏文字里抠出版本号。放这么早是因为「应用/撤销」那一步（5b）就要用 */
const versionOf = (s) => Number(/计划 v(\d+)/.exec(s)?.[1] ?? Number.NaN);
const control = page.locator('[data-testid="question-control"]');
const stepMeta = () => page.locator('div').filter({ hasText: /^第 \d+ 题/ }).first().textContent().catch(() => '');
/** 可点的前进按钮。刻意不含「正在取下一题…」——那表示服务端还没回 */
const readyBtn = () => page.getByRole('button', { name: /^(继续|先跳过这题)$/ }).last();

/**
 * 等服务端把下一题送回来。
 *
 * 这里必须按**元素出现**等待而不是睡固定毫秒：走本地题库时是毫秒级，
 * 走真实 LLM 时每题要 1–4 秒，一个写死的等待时间不可能同时适配两者。
 */
async function waitForNext() {
  await Promise.race([
    readyBtn().waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {}),
    page.getByText('信息够了', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {}),
  ]);
  await page.waitForTimeout(250);
}

/** 作答当前这一题。返回一句人话描述，便于日志里看出到底点了什么 */
async function answerCurrent() {
  const inputs = control.locator('textarea, input');
  const suggestion = control.locator('[aria-label^="填入"]').first();
  const radio = control.locator('[role="radio"]').first();
  const check = control.locator('[role="checkbox"]').first();
  const chip = control.locator('[role="button"]').first();

  if ((await inputs.count()) >= 2) {
    await inputs.nth(0).fill('2026-11-02');
    await inputs.nth(1).fill('2026-11-06');
    const reason = control.locator('[aria-label="原因：期中考试周"]').first();
    if (await reason.count()) await reason.click();
    return '填区间 2026-11-02 ~ 2026-11-06（期中考试周）';
  }
  if ((await suggestion.count()) > 0) {
    const label = await suggestion.getAttribute('aria-label');
    await suggestion.click();
    return `点建议「${label}」`;
  }
  if ((await radio.count()) > 0) {
    const label = await radio.getAttribute('aria-label');
    await radio.click();
    return `选「${label}」`;
  }
  if ((await check.count()) > 0) {
    const label = await check.getAttribute('aria-label');
    await check.click();
    return `勾「${label}」`;
  }
  if ((await chip.count()) > 0) {
    const label = await chip.getAttribute('aria-label');
    await chip.click();
    return `选档位「${label}」`;
  }
  if ((await inputs.count()) > 0) {
    await inputs.first().fill('2027-04-11');
    return '填日期 2027-04-11';
  }
  return '未作答（走跳过）';
}

/* ── 1. 记录初始计划版本 ──────────────────────────────────── */
await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(1000);
const beforeMeta = await planMeta();
log.push(`初始计划：${beforeMeta}`);
await shot('00-plan-before');

/* ── 2. 访谈逐题作答 ─────────────────────────────────────── */
await page.goto(`${base}/onboarding`, { waitUntil: 'networkidle' });
// 首题要等服务端（走 LLM 时约 3 秒）
await control.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(400);

for (let step = 0; step < 12; step++) {
  if (await page.getByText('信息够了', { exact: false }).count()) {
    log.push('→ 到达结束页');
    break;
  }
  const before = await stepMeta();
  const kind = await control.evaluate((el) => {
    const has = (sel) => el.querySelector(sel) !== null;
    if (has('[role="radio"]')) return 'single';
    if (has('[role="checkbox"]')) return 'multi';
    const n = el.querySelectorAll('input, textarea').length;
    if (n >= 2) return 'dateRange';
    if (n === 1) return el.querySelector('textarea') ? 'text' : 'date';
    return 'scale';
  });

  const action = await answerCurrent();
  await page.waitForTimeout(250);
  await shot(`${String(step + 1).padStart(2, '0')}-question`);
  await readyBtn().click();
  await waitForNext();

  const finished = (await page.getByText('信息够了', { exact: false }).count()) > 0;
  const after = await stepMeta();
  log.push(`第 ${step + 1} 题 [${kind}] ${action} → ${finished ? '结束页' : after !== before ? '已前进' : '⚠ 没有前进'}`);
  if (finished) break;
}
await shot('90-done');

/* ── 3. 生成计划，并断言计划真的被替换 ───────────────────── */
const genBtn = page.getByRole('button', { name: /^生成计划$/ }).last();
if ((await genBtn.count()) === 0) {
  log.push('⚠ 结束页上没有「生成计划」按钮');
} else {
  await genBtn.click();
  // 走 LLM 时生成要 30–40 秒，必须按元素出现等待
  await page
    .getByText('我的目标', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: 180_000 })
    .catch(() => log.push('⚠ 等待生成完成超时'));
  await page.waitForTimeout(600);
  await shot('91-after-generate');

  const afterMeta = await planMeta();
  log.push(`生成后：${afterMeta}`);
  if (afterMeta === beforeMeta) log.push('⚠ 计划版本没有变化——生成可能没生效');

  const goalOnPage = await page.getByText('我的目标', { exact: false }).count();
  if (!goalOnPage) log.push('⚠ 生成后没有回到计划页');
  const taskCount = await page.locator('[role="checkbox"]').count();
  log.push(`新计划当天可见任务数：${taskCount}`);
}

/* ── 4. 打勾 + 报实际用时，看引擎能否识别偏差 ─────────────── */
const firstCheckbox = page.locator('[role="checkbox"]').first();
if ((await firstCheckbox.count()) > 0) {
  await firstCheckbox.click();
  await page.waitForTimeout(700);
  const actual = page.locator('[aria-label="实际用时 120 分钟"]').first();
  if ((await actual.count()) > 0) {
    await actual.click();
    await page.waitForTimeout(700);
    log.push('已打勾一项并报实际用时 120 分钟');
  } else {
    log.push('⚠ 打勾后卡片没有展开出「实际用时」档位');
  }
  await shot('92-actual-recorded');
} else {
  log.push('⚠ 计划页上没有可勾选的任务');
}

/* ── 5. 复盘页：一屏六块里的前四块 ─────────────────────── */
/**
 * 复盘**不在底部标签栏里**了（它是推入的整屏）。入口在今日页右上角。
 *
 * 所以这一步必须先回今日页、再点那个入口；看完还要**退出来**——
 * 推入的屏没有标签栏，留在上面的话后面所有点标签的步骤都会失败。
 */
async function openReview(label) {
  await page.getByRole('tab', { name: '今日' }).click();
  await page.waitForTimeout(700);
  const entry = page.getByRole('button', { name: '开始复盘，把这一周过一遍' });
  if ((await entry.count()) === 0) {
    log.push(`⚠ 今日页上没有复盘入口（${label}）`);
    return false;
  }
  await entry.click();
  await page.waitForTimeout(1400);
  return true;
}

/** 从复盘退出来，回到今日页。走「先不聊了」——它同时也是放弃会话的入口 */
async function leaveReview() {
  const quit = page.getByRole('button', { name: '放弃这次复盘' });
  if ((await quit.count()) > 0) {
    await quit.click();
    await page.waitForTimeout(900);
  } else {
    // 兜底：直接回首页，别把整条流程卡在推入的屏上
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
  }
}

const enteredReview = await openReview('步骤 5');
if (!enteredReview) log.push('⚠ 没能进入复盘页');

// --waitAi：等模型把方向那句话写完再截图。走本地兜底时永远不会出现「AI」徽标，
// 所以这个等待只在连着服务端时才有意义（用开关而不是写死，避免白等 60 秒）。
if (argv.includes('--waitAi')) {
  await page
    .getByText('AI', { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
    .then(() => log.push('模型方向已返回'))
    .catch(() => log.push('⚠ 等待模型方向超时'));
}

await shot('93-review');

const factsVisible = await page.getByText('这周发生了什么', { exact: false }).first().isVisible().catch(() => false);
log.push(`复盘「这周发生了什么」：${factsVisible ? '✓ 可见' : '⚠ 不可见'}`);

// 事实句子来自引擎，断网时也必须有一句
const factsText = await page.getByText(/项落后|项超预估|项比预期快|没有发现偏差|已经过期|实际花了预估的/).first().textContent().catch(() => null);
log.push(`事实：${(factsText ?? '（没读到）').replace(/\s+/g, ' ').slice(0, 90)}`);

// 方向那句话以事实开头（「1 项耗时超预估。下周，…」），所以**不能锚定行首**
const direction = await page.getByText(/下周|按现在的节奏继续/).first().textContent().catch(() => null);
log.push(`方向：${(direction ?? '（没读到）').replace(/\s+/g, ' ').slice(0, 90)}`);

const cardHeading = await page.getByText(/^帮你写好的卡片 · \d+ 张$/).first().textContent().catch(() => null);
log.push(`卡片区：${cardHeading ?? '⚠ 没读到'}`);

/**
 * **卡片里的日期不能早于今天。**
 *
 * 这条来自一个真 bug：会话开得太早（时钟还没接上），引擎按设备日期算排期，
 * 卡片上就出现了相对真实今天已经过去的日期。断言把它钉住——
 * 从页面上的日期文本里挑出「M/D」，任何一个早于头部那个日期就是回归。
 */
const headDate = await page.getByText(/^\d+月\d+日 周[一二三四五六日] · 计划 v/).first().textContent().catch(() => null);
const todayMD = headDate ? /^(\d+)月(\d+)日/.exec(headDate) : null;
if (todayMD) {
  const todayKey = Number(todayMD[1]) * 100 + Number(todayMD[2]);
  const changes = await page.getByText(/^待排池 →|^\d+\/\d+ 周[一二三四五六日] →/).allTextContents();
  const tooEarly = changes.filter((c) => {
    const m = /^(\d+)\/(\d+) 周/.exec(c.trim());
    if (!m) return false;
    return Number(m[1]) * 100 + Number(m[2]) < todayKey;
  });
  log.push(
    `卡片日期不早于今天（${todayMD[1]}/${todayMD[2]}）：` +
      `${changes.length} 条里 ${tooEarly.length} 条过早 ${tooEarly.length ? '⚠ ' + tooEarly.join('、') : '✓'}`
  );
} else {
  log.push('⚠ 没读到复盘的日期，跳过卡片日期检查');
}

// 退出复盘再往下走：推入的整屏**没有标签栏**，留在上面后面每一步点标签都会超时
await leaveReview();

/* ── 5b. 应用复盘的建议，然后撤销 ───────────────────────── *
 * 撤销是这一轮新加的能力，也是唯一一个「会改计划」的按钮的反悔权。
 * 两条要验的性质：
 *   1. 应用之后通知上有〔撤销〕，而且撤销**真的把计划恢复回去了**；
 *   2. 撤销只对紧接着的那一次负责——再动一下别的东西，它就该消失。
 *
 * 顺带一个好处：撤销之后计划回到应用前，所以后面每一步看到的还是同一份计划。
 */
await openReview('步骤 5b');
const applyReview = page.getByRole('button', { name: /^应用 \d+ 张$/ });
if ((await applyReview.count()) === 0) {
  log.push('（这一步的复盘没有给出建议，跳过「应用 + 撤销」）');
} else {
  const beforeApply = versionOf(await planMeta());
  await applyReview.first().click();
  await page.waitForTimeout(2000);

  const vApplied = versionOf(await planMeta());
  const undoBtn = page.getByRole('button', { name: '撤销刚才这次改动' });
  const hasUndo = (await undoBtn.count()) > 0;
  log.push(
    `应用复盘建议：v${beforeApply} → v${vApplied} ` +
      `${vApplied === beforeApply + 1 ? '✓ 只前进一版' : `⚠ 版本变化是 ${vApplied - beforeApply}`} · ` +
      `〔撤销〕${hasUndo ? '✓ 有' : '⚠ 没有'}`
  );
  await shot('93b-applied-with-undo');

  if (hasUndo) {
    await undoBtn.first().click();
    await page.waitForTimeout(2200);
    const vUndone = versionOf(await planMeta());
    const saysUndone = await page.getByText('已撤销刚才那次改动').count();
    log.push(
      `撤销：v${vApplied} → v${vUndone} ` +
        `${vUndone === vApplied + 1 ? '✓ 恢复也是一次正常写入（+1 版）' : `⚠ 版本变化是 ${vUndone - vApplied}`} · ` +
        `提示${saysUndone ? '✓ 有' : '⚠ 没有'}`
    );

    // 再动一下别的东西：撤销入口应该消失（它不是版本管理，是一次动作的反悔权）
    // `:visible` 是必须的：栈里可能同时挂着两屏，按 DOM 顺序取到的第一个未必是看得见的那个
    const anyBox = page.locator('[role="checkbox"]:visible').first();
    if ((await anyBox.count()) > 0) {
      await anyBox.click();
      await page.waitForTimeout(1500);
      const stillThere = await page.getByRole('button', { name: '撤销刚才这次改动' }).count();
      log.push(
        `再改动一次之后〔撤销〕：${stillThere === 0 ? '✓ 已消失（只活到下一次改动之前）' : '⚠ 还在，边界没守住'}`
      );
    }
  }
}

/* ── 6. 文件页：真的落盘了吗 ─────────────────────────────── */
await page.getByRole('tab', { name: '文件' }).click();
await page.waitForTimeout(1200);
await shot('94-file-tab');

const backend = await page.getByText(/设备文件系统|浏览器存储/).first().textContent().catch(() => '');
const raw = await page.getByText(/studyplan\/v1/).first().textContent().catch(() => '');
const saveState = await page.getByText(/已保存到设备|正在写入|保存失败|已暂停写入|尚未写入/).first().textContent().catch(() => '');
log.push(`文件页：后端=${backend} 状态=${saveState} 文件含 studyplan/v1=${raw.includes('studyplan/v1') ? '是' : '否'}`);
/**
 * 「这一页显示的是盘上那份文件」这件事，得有个真判据。
 *
 * 版本快照列表那一块随「取消版本管理」一起撤掉了，所以原来读
 * 「版本快照 · N 个」的断言变成了永远读不到的摆设——一个永远不会失败的检查
 * 不是检查。换成拿**页头的版本号**和**正文里的 version:** 对一次：
 * 两处对得上，才说明预览不是内存里重新序列化出来的字符串。
 */
// 不写死 plan id：连真实模型那条路径生成出来的 id 可能不是示例里那个，
// 钉死 id 会变成一条只在离线路径上成立的断言
const fileMeta = (await page.getByText(/· v\d+ ·/).first().textContent().catch(() => '')) ?? '';
const fileVersion = Number(/v(\d+)/.exec(fileMeta)?.[1] ?? Number.NaN);
const rawVersion = Number(/version:\s*(\d+)/.exec(raw)?.[1] ?? Number.NaN);
log.push(
  `文件页版本：页头 v${fileVersion} · 正文 version: ${rawVersion} ` +
    (fileVersion === rawVersion ? '✓ 预览就是盘上那份' : '⚠ 对不上'),
);

/**
 * 学生档案。
 *
 * 断言落在**整个卡片**上而不是某一句人话上：访谈答了哪几题不固定，
 * `describeProfile` 拼出来的摘要就跟着变，钉死一句话会变成一个假失败。
 * 这里要证的是「文件里有档案、界面也读出来了」——
 * 而「还没有档案」只会在 `readProfile` 返回 null 时出现。
 */
const archive = page.locator('[data-testid="student-profile"]');
const archiveText = ((await archive.first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
const archiveSaved = archiveText.includes('已随文件保存');
log.push(`学生档案：${archiveSaved ? '✓ 已随文件保存' : '⚠ 显示为没有档案'} · ${archiveText.slice(0, 110)}`);

/* ── 7. 刷新后计划还在吗（持久化唯一的真凭据） ───────────── */
await page.getByRole('tab', { name: '今日' }).click();
await page.waitForTimeout(700);
const beforeReload = versionOf(await planMeta());

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.getByRole('tab', { name: '今日' }).click().catch(() => {});
await page.waitForTimeout(800);
const afterReload = versionOf(await planMeta());
await shot('95-after-reload');

log.push(`刷新前 v${beforeReload} → 刷新后 v${afterReload} ${beforeReload === afterReload ? '✓ 计划留住了' : '⚠ 计划丢了'}`);

/**
 * 档案的持久化要用**同一个刷新**来验。
 *
 * 「重开 App 它还记得你是谁」这句话唯一的凭据就在这里：刷新之后
 * 界面上的档案只能是 `hydrate` → `readProfile(plan)` 读出来的，
 * 内存里那份镜像已经随刷新没了。
 */
await page.getByRole('tab', { name: '文件' }).click();
await page.waitForTimeout(1400);
const archiveAfterReload = (
  (await page.locator('[data-testid="student-profile"]').first().textContent().catch(() => '')) ?? ''
).replace(/\s+/g, ' ');
log.push(
  archiveAfterReload.includes('已随文件保存')
    ? `刷新后学生档案：✓ 还在（内存镜像已随刷新清零，这份只能是从文件里读回来的）`
    : '⚠ 刷新后学生档案没了',
);
await shot('95b-after-reload-archive');
await page.getByRole('tab', { name: '今日' }).click();
await page.waitForTimeout(600);

/* ── 8. 刷新后还能操作吗（时钟对齐的验证） ───────────────── */
// 重启会把演示时钟的内存游标归零，而文件里的 meta.updated 已经前进过了。
// 不对齐的话这里会看到「没有执行：命令时间早于计划更新时间」。
const cb = page.locator('[role="checkbox"]').first();
if ((await cb.count()) > 0) {
  await cb.click();
  await page.waitForTimeout(1000);
  const notice = await page.getByText(/已更新|没有执行/).first().textContent().catch(() => '（没读到提示）');
  log.push(`刷新后再操作：${notice.replace(/\s+/g, ' ').slice(0, 70)}`);
  await shot('96-after-reload-action');
} else {
  log.push('⚠ 刷新后计划页上没有可勾选的任务');
}

/* ── 9. 工具调用：主动检索资料（§8） ─────────────────────── */
// 这一步验的是「系统主动去查了，而且知道该挂给哪条任务」。
// 静态截图证明不了它：要看到的是**点完之后计划和之前不一样了**。
/** 挂在最外层：第 11 步回滚之后要拿它做对比，证明内容真的回到了旧版本 */
let resourceCardCount = 0;
await page.getByRole('tab', { name: '资源' }).click();
await page.waitForTimeout(700);
const beforeRes = await page.locator('[aria-label^="打开 "]').count();

const findBtn = page.getByRole('button', { name: '按计划内容检索资料' });
if ((await findBtn.count()) > 0) {
  await findBtn.click();
  // 本机路径是毫秒级；走服务端要多等（实时赛事那一步会发 HTTP）
  await page.waitForTimeout(6000);
  const notice = await page.getByText(/检索到|没有新增|失败|已经是最新/).first().textContent().catch(() => '（没读到提示）');
  const afterRes = await page.locator('[aria-label^="打开 "]').count();
  resourceCardCount = afterRes;
  log.push(`找资料：${notice.replace(/\s+/g, ' ').slice(0, 90)}`);
  log.push(`资源卡 ${beforeRes} → ${afterRes} ${afterRes > beforeRes ? '✓ 拿到新资料' : '（没有新增）'}`);

  // 每张资源卡都必须说清楚「哪来的、什么时候核对的」，否则和模型编的链接
  // 在界面上没法区分。快照和实时是两套说法，所以这里两种都认
  const withSource = await page
    .getByText(/资料库快照 · 人工核对于|今天校验|昨天校验|天前校验|未记录核对时间/)
    .count();
  log.push(`写明来源与核对时间的资源条目：${withSource}（资源卡共 ${afterRes} 张）`);
  log.push(withSource >= afterRes ? '  ✓ 每张卡都写明了来源' : '  ⚠ 有卡片没写来源');

  await page.getByRole('tab', { name: '今日' }).click();
  await page.waitForTimeout(800);
  /**
   * 今日页上带「资料 N」胶囊的卡片数。
   *
   * 注意这只是**今天 + 待排**那一屏的数字，不是挂载总数：
   * 挂上的任务可能排在别的日子，那时这里是 0 而挂载其实是成功的。
   * 所以真正的判据是上面那条通知里的「挂到 N 个任务」——
   * 这里只作为"挂载在今天的任务上看得见"的补充证据。
   */
  const linked = await page.getByText(/^资料 \d+$/).count();
  log.push(`今日/待排屏上带「资料 N」胶囊的卡片：${linked} 张（挂载总数以通知为准）`);
  await shot('97-after-find-resources');

  /**
   * 复盘页的「提醒」列表。
   *
   * 这一步是冲着真机上那个报错来的：那一列曾经用警告**文案**当 React key，
   * 而工具调用会一次带进好几个「没有截止日的赛事」（蓝桥杯之类 + 演示时钟下
   * 的实时赛程），它们触发的警告文案一模一样 —— 于是
   * `Encountered two children with the same key`。
   *
   * 真正的判据是**有没有 console 错误**（脚本末尾统一收口），
   * 所以这里只把标题读出来记一笔，不去 DOM 里翻列表——
   * 按文本抓"那一列"会连祖先节点一起抓到，读出来的数字没有意义。
   */
  await openReview('步骤 10');
  const cautionLabel = await page
    .getByText(/^提醒 · \d+ 条$|^提醒$/)
    .first()
    .textContent()
    .catch(() => null);
  log.push(`复盘页提醒区：${cautionLabel ?? '（这一版没有提醒）'}`);
  await shot('97b-review-after-resources');
  await leaveReview();
} else {
  log.push('⚠ 资源页没有找到「按计划内容检索资料」按钮');
}

/* ── 10. 导出：真的下载到文件了吗 ───────────────────────── *
 * 导出不能只看"点了没报错"——要真的接住浏览器下载，看文件名和内容。
 * 日历文件还要顺手验证它是 CRLF 的：用 \n 的 .ics 有些客户端直接拒收。
 */
await page.getByRole('tab', { name: '文件' }).click();
await page.waitForTimeout(700);

for (const [label, ext] of [
  ['导出 Markdown', '.md'],
  ['导出日历', '.ics'],
]) {
  const chip = page.getByRole('button', { name: label });
  if ((await chip.count()) === 0) {
    log.push(`⚠ 文件页上没有找到「${label}」`);
    continue;
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
    chip.click(),
  ]);
  if (!download) {
    log.push(`⚠ ${label}：没有触发下载`);
    continue;
  }
  const name = download.suggestedFilename();
  const file = path.join(outDir, `export${ext}`);
  await download.saveAs(file);
  const content = fs.readFileSync(file, 'utf8');
  const looksRight = ext === '.md' ? content.startsWith('# ') : content.startsWith('BEGIN:VCALENDAR');
  const crlf = ext === '.ics' ? content.includes('\r\n') : true;
  log.push(
    `导出 ${ext}：${name} · ${content.length} 字符 ${looksRight ? '✓ 内容像样' : '⚠ 内容不对'}` +
      (ext === '.ics' ? ` · ${crlf ? '✓ CRLF' : '⚠ 不是 CRLF'}` : ''),
  );
}

/* ── 10b. 日历：入口、整月负载、翻月、点一天看那天 ────────── *
 * 分两段验，因为它们要证的是两件事：
 *   1. 今日页上那个「日历」按钮**真的会导航**（点它、看到只有日历屏才有的标题）
 *   2. 日历屏本身的行为（42 格、翻月、点一天换列表）
 *
 * 第 2 段**直接打开 `/calendar`**，而不是顺着第 1 段点下去。
 * 原因是个真实的坑：推入的屏不会把上一屏卸载，而周条和月历的格子
 * 无障碍标签长得一模一样（都是「19 日，2 项任务」），
 * 接着数会得到 42 + 7 = 49 个格子，分不清哪个是哪个。
 * 直接打开就只有一个屏，断言才是确定的。
 */
await page.getByRole('tab', { name: '今日' }).click();
await page.waitForTimeout(600);
const calBtn = page.getByRole('button', { name: '打开日历，看整个月的安排' });
if ((await calBtn.count()) > 0) {
  await calBtn.click();
  await page.waitForTimeout(1300);
  const onCal = await page
    .getByText(/^\d{4} 年 \d+ 月 · 本月 \d+ 项/)
    .first()
    .isVisible()
    .catch(() => false);
  log.push(`点「日历」：${onCal ? '✓ 进了日历屏' : '⚠ 没进去'}`);
  await shot('96b-calendar-enter');
} else {
  log.push('⚠ 今日页上没有「日历」按钮');
}

await page.goto(`${base}/calendar`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);

const cells = page.locator('[aria-label*=" 项任务"]');
const cellCount = await cells.count();
log.push(`月历格子数：${cellCount}${cellCount === 42 ? ' ✓ 固定 6 行（高度不会随月份跳）' : ' ⚠ 应该是 42'}`);
const firstCell = await cells.first().getAttribute('aria-label');
log.push(`第一格：${firstCell ?? '（没读到）'}（周一为一周之首）`);

const monthLabel = () => page.getByText(/^\d{4} 年 \d+ 月$/).first().textContent().catch(() => '(没读到)');
const m0 = await monthLabel();
await page.getByRole('button', { name: '下一个月' }).click();
await page.waitForTimeout(700);
const m1 = await monthLabel();
await page.getByRole('button', { name: '上一个月' }).click();
await page.waitForTimeout(700);
const m2 = await monthLabel();
log.push(
  `翻月：${m0} → ${m1} → ${m2} ${m1 !== m0 && m2 === m0 ? '✓ 能翻也能翻回来' : '⚠ 翻月不对'}`,
);

// 「14 日」只在月历里出现（周条只画当周那七天），所以这个定位不会有歧义
await page.getByRole('button', { name: /^14 日，/ }).first().click();
await page.waitForTimeout(900);
const dayHeading = await page
  .getByText(/^(今天|\d+月\d+日 周[一二三四五六日]) · \d+ 项/)
  .last()
  .textContent()
  .catch(() => null);
const h = (dayHeading ?? '（没读到）').replace(/\s+/g, ' ');
log.push(`点「14 日」之后：${h} ${h && !h.startsWith('今天') ? '✓ 下面换成了那天' : '⚠ 没跟着换'}`);
await shot('96c-calendar-day');

const backBtn = page.getByRole('button', { name: '回到今日页' });
if ((await backBtn.count()) > 0) {
  await backBtn.click();
  await page.waitForTimeout(1100);
  const backHome = await page.getByRole('button', { name: '打开日历，看整个月的安排' }).count();
  log.push(`从日历返回：${backHome > 0 ? '✓ 回到今日页' : '⚠ 没回去'}`);
} else {
  log.push('⚠ 日历屏上没有「返回」');
}

/* ── 11. 回归结账 ───────────────────────────────────────── *
 * 这一步验的是这一轮新加的那条链路：隔了几天再打开时，系统得自己发现
 * 「有几项已经过期了」，而不是把一张什么都没变的表格继续摆在那儿。
 *
 * 演示当天没法真的等一天，所以走文件页那个「模拟隔了 5 天回来」按钮——
 * 它同时是演示开关和这条链路的测试入口。
 *
 * 先把固定日期设成**当前这一天**（点「今天」），而不是写死一个日期：
 * 窗口是 (今天, 今天+5]，而计划是围绕「今天」生成的。写死一个日期的话，
 * 这条断言会变成在赌「今天几号」，跟功能好坏没关系。
 *
 * **但光钉住日期还不够。** 2026-10-05（周一）那天跑，这一步报的是
 * 「结账页上没有找到确认按钮」——不是功能坏了，而是：访谈里学生只勾了
 * 「周一晚上」，而那天**正好是周一**，于是生成计划把所有任务都排到了今天，
 * 正好落在结算区间**左开的那个端点之外**（「上次打开那天不算欠账」是设计如此），
 * 窗口里一项都没有。这条断言其实还依赖了「今天是周几」。
 *
 * 修法是让窗口里**一定会有一项**：现场新建一项排到明天。
 * 新任务必定是 todo，明天必定落在 (今天, 今天+5] 里，于是与星期几无关。
 * 顺带把新建这条路径也走了一遍。
 */
await page.getByRole('tab', { name: '今日' }).click();
await page.waitForTimeout(700);
const addBtn = page.getByRole('button', { name: /^新加一项到/ });
if ((await addBtn.count()) > 0) {
  await addBtn.first().click();
  await page.waitForTimeout(1200);
  await page.locator('[aria-label="任务标题"]').fill('结算用的临时任务');
  await page.getByRole('button', { name: '排到明天' }).click();
  await page.waitForTimeout(400);
  // `exact: true` 是必须的：编辑页顶部的「返回」无障碍标签是「不保存，返回」，
  // 而 Playwright 的 name 默认是子串匹配，不加就会同时命中两个
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1600);
  const created = await page.getByText('结算用的临时任务').count();
  log.push(`新建一项排到明天：${created > 0 ? '✓ 卡片出现了' : '⚠ 没看到新卡片'}`);
  await shot('97b-created-task');
} else {
  log.push('⚠ 今日页上没有「+ 新任务」入口');
}

await page.getByRole('tab', { name: '文件' }).click();
await page.waitForTimeout(700);

const fixedMode = page.getByRole('button', { name: '时间固定在指定日期' });
if ((await fixedMode.count()) === 0) {
  log.push('⚠ 文件页上没有「固定日期」开关');
} else {
  await fixedMode.click();
  await page.waitForTimeout(400);

  const todayChip = page.getByRole('button', { name: '固定日期改为今天' });
  if ((await todayChip.count()) > 0) {
    await todayChip.click();
    await page.waitForTimeout(600);
  } else {
    log.push('⚠ 没有找到「今天」快捷档位');
  }

  // 顺带验一下任意日期输入是活的：填一个未来的日期应该立刻生效
  const dateInput = page.locator('[aria-label="固定日期，格式为年-月-日"]');
  if ((await dateInput.count()) > 0) {
    await dateInput.fill('2026-12-25');
    await dateInput.press('Enter');
    await page.waitForTimeout(500);
    const arbitrary = await page.getByText(/今天是 2026-12-25/).count();
    log.push(`任意日期输入：${arbitrary > 0 ? '✓ 能设成 2026-12-25' : '⚠ 填了没生效'}`);
    // 放回今天，免得下面那个窗口里一项任务都没有
    if ((await todayChip.count()) > 0) await todayChip.click();
    await page.waitForTimeout(500);
  } else {
    log.push('⚠ 没有找到固定日期的输入框');
  }
  await shot('98-clock-fixed');

  /**
   * 结算前的版本号必须在**所有准备动作之后**取。
   *
   * 上面「新建一项排到明天」本身就 +1 版；如果拿它之前的号来比，
   * 这里会报「版本变化是 2」——看起来像结算多推了一版，
   * 其实是量错了基准。第一次跑就是这么误报的。
   */
  const beforeSettle = versionOf(await planMeta());

  const simulate = page.getByRole('button', { name: '模拟隔了五天回来' });
  if ((await simulate.count()) > 0) {
    await simulate.click();
    await page.waitForTimeout(1500);
    await shot('99-settle');

    // 结账页出现之后，先把清单读出来
    const heading = await page
      .getByText(/^这 \d+ 项，实际情况是$/)
      .first()
      .textContent()
      .catch(() => null);
    const summary = await page
      .getByText(/距上次打开过了 \d+ 天|这期间/)
      .first()
      .textContent()
      .catch(() => null);
    log.push(`结账页：${heading ?? '（没读到清单标题）'}`);
    log.push(`叙述：${(summary ?? '（没读到）').replace(/\s+/g, ' ').slice(0, 90)}`);

    const confirm = page.getByRole('button', { name: '确认' });
    if (heading && (await confirm.count()) > 0) {
      await confirm.click();
      await page.waitForTimeout(2500);
      const after = versionOf(await planMeta());
      log.push(
        `结账：v${beforeSettle} → v${after} ` +
          `${after === beforeSettle + 1 ? '✓ 只前进了一版（一次结算 = 一条命令）' : `⚠ 版本变化是 ${after - beforeSettle}`}`,
      );

      // 内容真的变了吗？默认「放回待排池」，所以待排池应该变长了
      await page.getByRole('tab', { name: '今日' }).click();
      await page.waitForTimeout(800);
      const backlog = await page.getByText(/^待排 · \d+ 项$/).first().textContent().catch(() => null);
      const settled = await page.getByText(/结账 [\d-]+ ~ [\d-]+/).first().textContent().catch(() => null);
      log.push(`结账后今日页：${(settled ?? '（没读到通知）').replace(/\s+/g, ' ').slice(0, 80)} · ${backlog ?? '没有待排区'}`);
      await shot('99b-after-settle');
    } else {
      // 走到这里说明连「明天有一项」都没让它出现，那多半是真出问题了。
      // 把系统的原话带出来，省得下次还得靠猜
      const why = await page
        .getByText(/之间没有需要结算的任务|计划文件读取失败|存储不可用/)
        .first()
        .textContent()
        .catch(() => null);
      log.push(`⚠ 结账页上没有「确认」按钮${why ? `（系统说：${why.replace(/\s+/g, ' ')}）` : ''}`);
    }
  } else {
    log.push('⚠ 文件页上没有「模拟隔了 5 天回来」按钮');
  }

  // 把时钟放回正常模式，别把调试状态留给下一次跑
  const liveMode = page.getByRole('button', { name: '时间跟随服务器' });
  if ((await liveMode.count()) > 0) await liveMode.click();
  await page.waitForTimeout(400);
}

/* ── 11b. 跟 AI 说说：断网时必须**明说不可用** ───────────── *
 * 这一条没有本机兜底，而这是**有意的**：自然语言理解本机做不到，
 * 做一个「只听得懂三句话」的关键词解析器，学生试两次失败之后就不信它了。
 *
 * 所以这里要验的不是「它能工作」，而是「它不会假装在工作」：
 * 打一句话 → 那句话还在（不丢）→ 明确说现在用不了 → 给手动入口。
 */
await page.getByRole('tab', { name: '今日' }).click();
await page.waitForTimeout(700);
const talkFab = page.getByRole('button', { name: '跟 AI 说说你的计划' });
if ((await talkFab.count()) > 0) {
  await talkFab.click();
  await page.waitForTimeout(1200);

  const hasExamples = await page.getByText('试试这样说').first().isVisible().catch(() => false);
  log.push(`跟 AI 说说空态：${hasExamples ? '✓ 给了三个可用例子' : '⚠ 没有例子'}`);

  await page
    .getByRole('button', { name: /^用这个例子：/ })
    .first()
    .click();
  await page.waitForTimeout(2500);

  const saidSo = await page.getByText('现在用不了').first().isVisible().catch(() => false);
  const manual = await page.getByRole('button', { name: '打开日历，自己挪' }).count();
  const keptWord = await page.getByText('周三晚上有事').first().isVisible().catch(() => false);
  log.push(
    `断网时：${saidSo ? '✓ 明说「现在用不了」' : '⚠ 没明说（可能在假装工作）'} · ` +
      `手动入口 ${manual} 个 · 那句原话${keptWord ? '还在' : '⚠ 丢了'}`
  );
  await shot('100b-talk-offline');

  const backFromTalk = page.getByRole('button', { name: '返回' }).first();
  if ((await backFromTalk.count()) > 0) {
    await backFromTalk.click();
    await page.waitForTimeout(900);
  }
} else {
  log.push('⚠ 今日页上没有「跟 AI 说说」入口');
}

/* ── 12. 演示模式（现场保险） ────────────────────────────── */
// 上一步最后停在资源页，开关在文件页
await page.getByRole('tab', { name: '文件' }).click();
await page.waitForTimeout(700);
const openDemo = page.getByRole('button', { name: '打开演示模式，只用本机' });
if ((await openDemo.count()) > 0) {
  await openDemo.click();
  await page.waitForTimeout(400);
  const on = await page.getByText('演示模式：已开启').count();
  log.push(`演示模式：${on > 0 ? '✓ 可开启（开启后一次网络请求都不发）' : '⚠ 开关没生效'}`);
  await shot('100-demo-mode');
  // 关掉，别把状态留给下一次跑
  const closeDemo = page.getByRole('button', { name: '关闭演示模式，允许联网调用模型' });
  if ((await closeDemo.count()) > 0) await closeDemo.click();
  await page.waitForTimeout(300);
} else {
  log.push('⚠ 文件页上没有演示模式开关');
}

console.log(log.join('\n'));
console.log(`\n截图输出：${path.relative(WORKSPACE, outDir)}`);

if (problems.length) {
  console.log('\n页面报错：');
  for (const p of [...new Set(problems)].slice(0, 20)) console.log('  - ' + p);
  process.exitCode = 2;
} else {
  console.log('无 console/page 错误。');
}

await browser.close();
server.close();
