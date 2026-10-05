/**
 * 多目标的**真实模型**探针：一句话新增一条线，并看它有没有被排进时间。
 *
 * 为什么必须打真实模型：这一条链路的输入是自然语言，而「模型会不会按新提示词
 * 输出 `addMilestone`、会不会把新任务的日期留空」是**提示词质量问题**，
 * 单测证明不了——单测喂的是我自己写的理想 JSON。
 *
 * 用法：先起服务端（要配 LLM_API_KEY），再
 *   node .dev/probe-multigoal.mjs ["学生说的话"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SP_SERVER ?? 'http://127.0.0.1:8787';
const said =
  process.argv[2] ??
  '学校 12 月 28 日有个选拔赛，帮我加一条线：把搜索和贪心练一练，能独立做出中等难度的题';

const plan = fs.readFileSync(path.join(WORKSPACE, 'examples', 'demo.studyplan'), 'utf8');

/**
 * 演示文件的日期口径是 2026-10-19（它的 meta.updated 就是那天）。
 * 传真实今天会让「12 月 28 日」这个未来日期看起来更远，而示例里的排期都在 10 月，
 * 对齐之后模型看到的和学生看到的是同一张表。
 */
const TODAY = '2026-10-19';

const body = {
  plan,
  today: TODAY,
  profile: null,
  history: [{ role: 'student', text: said }],
};

console.log(`→ 学生说：${said}`);
console.log(`→ POST ${BASE}/plan/talk（today=${TODAY}）\n`);

const res = await fetch(`${BASE}/plan/talk`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await res.json();

if (!json.ok) {
  console.log(`✗ 服务端返回 ok=false：${json.error ?? JSON.stringify(json)}`);
  process.exit(1);
}

const r = json.result;
console.log(`【听懂了】${r.understanding}`);
if (r.close) console.log(`【收尾】${r.close}`);

if (r.questions.length) {
  console.log('\n【它先问】');
  for (const q of r.questions) console.log(`  ？ ${q.prompt}\n     为什么：${q.why}`);
}
if (r.refusals.length) {
  console.log('\n【它说做不到】');
  for (const x of r.refusals) console.log(`  ✗ ${x}`);
}

console.log(`\n【提案 ${r.proposals.length} 条】`);
for (const p of r.proposals) console.log(`  · ${p.kind}  —— ${p.reason}`);
if (r.dropped) console.log(`  （另有 ${r.dropped} 条被把关层丢掉）`);

/* ── 这一轮真正要看的东西 ─────────────────────────────── */

const added = r.proposals.filter((p) => p.kind === 'addMilestone');
if (!added.length) {
  console.log('\n⚠ 这一轮没有给出 addMilestone。');
  console.log('  可能的原因：模型觉得该先问清楚（看上面的 questions），');
  console.log('  或者提示词里的新目标说明它没照做。换一句话再试一次。');
  process.exit(2);
}

console.log(`\n✓ 给出了 ${added.length} 条新增目标`);
for (const a of added) {
  const total = a.tasks.reduce((s, t) => s + t.estimateMin, 0);
  console.log(`\n  目标「${a.milestone.title}」`);
  console.log(`    截止：${a.milestone.due ?? '（没有截止日）'}`);
  console.log(`    判据：${a.milestone.criteria.join(' / ') || '（没写）'}`);
  console.log(`    能力点：${a.milestone.competences.join('、') || '（没写）'}`);
  console.log(`    任务 ${a.tasks.length} 项，合计 ${Math.round(total / 60)} 小时：`);

  const dates = [];
  for (const t of a.tasks) {
    dates.push(t.scheduledFor);
    console.log(`      ${t.scheduledFor ?? '（待排池）'}  ${t.estimateMin} 分钟  ${t.title}`);
  }
  /**
   * **这一条才是「排期」的证据。**
   *
   * 模型被要求把 `scheduledFor` 留空，日期由 `placeNewTasks()` 跑引擎算出来再写回卡片。
   * 所以只要这里看到真实日期，就说明「投影 → 跑引擎 → 写回」这条链真的通了；
   * 全是 null 则说明引擎没排进去（容量不够，或者那一步没跑到）。
   */
  const placed = dates.filter(Boolean);
  console.log(
    placed.length === dates.length
      ? `    ✓ ${placed.length} 项全部排出真实日期（引擎排的，不是模型编的）`
      : `    ⚠ ${dates.length - placed.length} 项没排进去（在待排池里）`
  );
}

/* ── 第二步：这张卡真的能落地吗 ─────────────────────────
 * 「模型产出格式对」和「这张卡能写进计划」是两件事。真机上撞过一次
 * 只差一个字段就整条被丢的情况，所以这里一路走到底：分配 id → 落成命令载荷
 * → 应用 → 校验整份计划 → 复盘能不能看见这条新线。
 */
const { applyCommand, allocateIds, proposalKey, toAppliedAdjustment, validatePlan, reviewPlan, parsePlan } =
  await import('@sp/shared');

const parsed = parsePlan(plan);
if (!parsed.ok) throw new Error(parsed.error);

// 和界面写入时**同一个**纯函数分配 id——两处各算一次的话会错位
const ids = allocateIds(parsed.plan, r.proposals);
const applied = r.proposals.map((p) => toAppliedAdjustment(p, ids.get(proposalKey(p))));

const res2 = applyCommand(parsed.plan, { type: 'plan.applyAdjustments', at: '2026-10-19T21:00:00+08:00', applied });
if (!res2.ok) {
  console.log(`\n✗ 落不了地：${res2.error}`);
  process.exit(3);
}

const next = res2.plan;
console.log(`\n【应用之后】v${parsed.plan.version} → v${next.version}`);
console.log(`  目标（线）：${next.milestones.map((m) => `${m.title}${m.due ? `（${m.due}）` : ''}`).join(' / ')}`);
console.log(`  能力点：${next.competences.map((c) => c.name).join('、')}`);
console.log(`  任务：${next.tasks.length} 项（原 ${parsed.plan.tasks.length} 项）`);
console.log(`  历史摘要：${next.history.at(-1)?.summary}`);

const errors = validatePlan(next).filter((i) => i.level === 'error');
console.log(errors.length ? `  ✗ 校验错误 ${errors.length} 条：${errors.map((e) => e.message).join('；')}` : '  ✓ 校验零错误');

if (added.length) {
  const report = reviewPlan(next, TODAY);
  const risky = report.drift.filter((d) => d.kind === 'milestoneRisk');
  console.log(
    `  复盘看到 ${next.milestones.length} 条线，其中 ${risky.length} 条报风险` +
      (risky.length ? `（${risky.map((d) => next.milestones.find((m) => m.id === d.milestoneId)?.title).join('、')}）` : '')
  );
}

