/**
 * 打真实端点，验证 LLM 路径（而不只是本地兜底）。
 *
 * 全是本地兜底通过说明不了模型接得上——本地路径永远不会失败，
 * 所以它会掩盖「服务端其实一直没被调用」这种事。
 * 这个脚本把每一步的 source 和 note 打出来，一眼能看出走的是哪条路。
 *
 * 用法：node .dev/try-endpoints.mjs [--port 8787]
 */
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = `http://127.0.0.1:${arg('port', '8787')}`;

async function post(path, body, timeoutMs = 240_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { status: res.status, data: await res.json() };
  } catch (e) {
    return { status: 0, data: { error: e instanceof Error ? e.message : String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

const profile = {
  goalStatement: '明年四月能独立做出省赛中等难度的题，别再一看到 DP 就放弃',
  deadline: '2027-04-11',
  level: 'intermediate',
  weeklyHours: 6,
  weekdays: ['mon', 'wed', 'sat'],
  weakSpots: ['动态规划', '图论'],
  blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }],
};

const health = await fetch(`${BASE}/health`).then((r) => r.json());
console.log('health:', JSON.stringify(health.llm));

/* ── interview.nextTurn ─────────────────────────────────── */
console.log('\n=== POST /interview/next ===');
for (const asked of [[], [{ id: 'q_goal', kind: 'text', prompt: '你想达成什么？', why: '占位', options: [], min: null, max: null, step: null, unit: null, placeholder: null, suggestions: [] }]]) {
  const r = await post('/interview/next', { profile: asked.length ? profile : {}, asked });
  if (r.status !== 200) {
    console.log(`  HTTP ${r.status}`, JSON.stringify(r.data).slice(0, 300));
    continue;
  }
  const d = r.data;
  console.log(`  source=${d.source}  done=${d.done}`);
  console.log(`  note=${d.note}`);
  if (d.question) console.log(`  题目[${d.question.kind}] ${d.question.prompt}\n    why: ${d.question.why}`);
  console.log(`  还缺: ${(d.missing ?? []).join('、') || '（无）'}`);
}

/* ── planner.draft ──────────────────────────────────────── */
console.log('\n=== POST /plan/draft ===');
const at = '2026-10-19T22:30:00+08:00';
const t0 = Date.now();
const r = await post('/plan/draft', { profile, today: '2026-10-19', at, id: 'plan_czw01' });
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s  HTTP ${r.status}`);

if (r.status !== 200) {
  console.log('  ' + JSON.stringify(r.data).slice(0, 600));
} else {
  const d = r.data;
  console.log(`  source=${d.source}  repaired=${d.repaired}`);
  console.log(`  note=${d.note}`);
  console.log(`  summary=${d.summary}`);
  console.log(`  警告 ${d.warnings?.length ?? 0} 条`);
  for (const w of (d.warnings ?? []).slice(0, 5)) console.log(`    [${w.level}] ${w.path}: ${w.message}`);

  // 用共享层的校验器独立复查一遍——「返回 200」不等于「计划是对的」
  const { parsePlan, validatePlan } = await import('@sp/shared');
  const parsed = parsePlan(d.plan);
  if (!parsed.ok) {
    console.log(`  ✕ 返回的计划无法解析：${parsed.error}`);
  } else {
    const plan = parsed.plan;
    const errors = validatePlan(plan).filter((i) => i.level === 'error');
    console.log(`  独立复查：error ${errors.length} 条`);
    for (const e of errors.slice(0, 5)) console.log(`    ${e.path}: ${e.message}`);

    // 学生说过的约束，模型有没有真的遵守
    const NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const wd = (day) => NAMES[new Date(Date.parse(`${day}T12:00:00Z`)).getUTCDay()];
    const offDays = plan.tasks.filter((t) => t.scheduledFor && !profile.weekdays.includes(wd(t.scheduledFor)));
    const inBlackout = plan.tasks.filter(
      (t) => t.scheduledFor && profile.blackouts.some((b) => t.scheduledFor >= b.from && t.scheduledFor <= b.to),
    );
    const backlog = plan.tasks.filter((t) => !t.scheduledFor).length;
    console.log(`  任务 ${plan.tasks.length} 个（待排 ${backlog}）· 里程碑 ${plan.milestones.length} · 能力点 ${plan.competences.length}`);
    console.log(`  排在非可用日：${offDays.length} 个${offDays.length ? ' ← 违反了学生的自述' : ' ✓'}`);
    console.log(`  排进不可用区间：${inBlackout.length} 个${inBlackout.length ? ' ← 违反了学生的自述' : ' ✓'}`);

    const mins = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
    const capacity = plan.constraints.availableSlots.reduce((s, x) => s + (mins(x.to) - mins(x.from)), 0);
    console.log(`  周预算 ${plan.constraints.weeklyMinutes} 分钟 vs 时段容量 ${capacity} 分钟 ${capacity === plan.constraints.weeklyMinutes ? '✓' : '← 对不上'}`);
  }
}
