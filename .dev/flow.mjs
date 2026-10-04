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

/* ── 5. 复盘页看引擎怎么说 ───────────────────────────────── */
// 注意：底部 tab 的各个屏幕会**同时挂在 DOM 里**（未选中的只是隐藏），
// 所以不能用「页面里有没有这段文字」来判断当前在哪一屏——
// 会读到上一屏的内容。要看的是「这一屏专有的元素是否可见」。
await page.getByRole('tab', { name: '复盘' }).click();
await page.waitForTimeout(1000);

// --waitAi：等模型把综述写完再截图。走本地兜底时永远不会出现「AI 综述」，
// 所以这个等待只在连着服务端时才有意义（用开关而不是写死，避免白等 60 秒）。
if (argv.includes('--waitAi')) {
  await page
    .getByText('AI 综述', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
    .then(() => log.push('模型综述已返回'))
    .catch(() => log.push('⚠ 等待模型综述超时'));
}

await shot('93-review-after-checkin');

const onReview = await page.getByText(/系统综述|AI 综述/, { exact: false }).first().isVisible().catch(() => false);
log.push(`复盘页可见：${onReview ? '是' : '⚠ 否'}`);

if (onReview) {
  const narrative = await page
    .locator('div')
    .filter({ hasText: /^(系统综述|AI 综述)/ })
    .last()
    .textContent()
    .catch(() => '');
  log.push(`综述来源与内容：${narrative.replace(/\s+/g, ' ').slice(0, 120)}`);

  const driftChips = await page.getByText(/项耗时超预估|项比预期快|项落后|个里程碑有风险/).allTextContents();
  log.push(`偏差标签：${[...new Set(driftChips)].join(' | ') || '（无）'}`);

  const section = await page.getByText(/^待确认的调整|^本周无需调整/).first().textContent().catch(() => '');
  log.push(`调整区：${section.replace(/\s+/g, ' ').slice(0, 80)}`);
}

/* ── 6. 文件页：真的落盘了吗 ─────────────────────────────── */
await page.getByRole('tab', { name: '文件' }).click();
await page.waitForTimeout(1200);
await shot('94-file-tab');

const backend = await page.getByText(/设备文件系统|浏览器存储/).first().textContent().catch(() => '');
const raw = await page.getByText(/studyplan\/v1/).first().textContent().catch(() => '');
const saveState = await page.getByText(/已保存到设备|正在写入|保存失败|已暂停写入|尚未写入/).first().textContent().catch(() => '');
const snaps = await page.getByText(/^版本快照 · \d+ 个$/).first().textContent().catch(() => '(没读到)');
log.push(`文件页：后端=${backend} 状态=${saveState} 文件含 studyplan/v1=${raw.includes('studyplan/v1') ? '是' : '否'} ${snaps}`);

/* ── 7. 刷新后计划还在吗（持久化唯一的真凭据） ───────────── */
const versionOf = (s) => /计划 v(\d+)/.exec(s)?.[1] ?? '?';
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
  await page.getByRole('tab', { name: '复盘' }).click();
  await page.waitForTimeout(1500);
  const cautionLabel = await page
    .getByText(/^提醒 · \d+ 条$|^提醒$/)
    .first()
    .textContent()
    .catch(() => null);
  log.push(`复盘页提醒区：${cautionLabel ?? '（这一版没有提醒）'}`);
  await shot('97b-review-after-resources');
  await page.getByRole('tab', { name: '今日' }).click();
  await page.waitForTimeout(500);
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

/* ── 11. 版本历史与回滚 ─────────────────────────────────── *
 * 快照一直在写，但界面入口是这一轮才补上的。要验的是**回滚真的换了内容**，
 * 而不只是"按钮点了没报错"。
 */
const beforeRollback = versionOf(await planMeta());
const histLink = page.getByRole('button', { name: '查看版本历史' });
if ((await histLink.count()) > 0) {
  await histLink.click();
  await page.waitForTimeout(1200);
  await shot('98-history');

  const rollback = page.getByRole('button', { name: /^回滚到 v\d+$/ });
  const n = await rollback.count();
  if (n > 0) {
    const targetLabel = await rollback.nth(n - 1).getAttribute('aria-label');
    const target = Number((targetLabel ?? '').match(/v(\d+)/)?.[1] ?? 0);
    await rollback.nth(n - 1).click();
    await page.waitForTimeout(300);
    // 两步确认：第二次点击才真的执行
    const confirm = page.getByRole('button', { name: `确认回滚到 v${target}` });
    if ((await confirm.count()) > 0) await confirm.click();
    await page.waitForTimeout(2000);
    const after = versionOf(await planMeta());
    await page.waitForTimeout(500);
    await shot('99-after-rollback');

    /**
     * 版本号变了还不够——要证明**内容**真的回到了那一版。
     * 最省事的判据是资源条数：找资料是在 v1 之后做的，
     * 回滚到 v1 就该把后来加的那些丢掉。
     */
    await page.getByRole('tab', { name: '资源' }).click();
    await page.waitForTimeout(900);
    const resAfter = await page.locator('[aria-label^="打开 "]').count();
    log.push(
      `版本历史：${n} 个历史版本 · 从 v${beforeRollback} 回滚 v${target} → 现在 v${after}` +
        `${after > beforeRollback ? '，版本继续前进 ✓' : '，⚠ 版本没动'}`,
    );
    log.push(
      `回滚后的内容：资源卡 ${resourceCardCount} → ${resAfter} ` +
        `${resAfter < resourceCardCount ? '✓ 后面的改动被丢掉了，确实回到了旧版本' : '⚠ 内容没变，回滚可能没生效'}`,
    );
  } else {
    log.push('⚠ 版本历史页上没有可回滚的版本');
  }
} else {
  log.push('⚠ 文件页上没有「查看版本历史」入口');
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
