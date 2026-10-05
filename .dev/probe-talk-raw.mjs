/**
 * 把模型对 `/talk` 的**原始输出**打出来。
 *
 * 存在的理由是一次真实的排查：探针显示「另有 1 条被把关层丢掉」，
 * 但 refusals 里没有任何理由——因为丢在 `Proposal.safeParse` 那一层时
 * 只计数、不说话。看不到原文就只能猜。
 *
 * 用法：node .dev/probe-talk-raw.mjs ["学生说的话"]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '@sp/env-node';
import { createOpenAiCompatProvider, completeJson } from '@sp/llm-client';
import { TalkOutput, buildTalkMessages, resolveTalkOutput, parsePlan } from '@sp/shared';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile({ startDir: WORKSPACE });
const cfg = {
  baseUrl: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
  jsonMode: process.env.LLM_JSON_MODE === '1',
};

if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
  console.log('✗ .env 里没有 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  process.exit(1);
}

const said = process.argv[2] ?? '学校 12 月 28 日有个选拔赛，帮我加一条线：把搜索和贪心练一练';
const TODAY = '2026-10-19';
const planText = fs.readFileSync(path.join(WORKSPACE, 'examples', 'demo.studyplan'), 'utf8');
const parsed = parsePlan(planText);
if (!parsed.ok) throw new Error(parsed.error);

const provider = createOpenAiCompatProvider(cfg);

const messages = buildTalkMessages({
  plan: planText,
  today: TODAY,
  profile: null,
  milestones: parsed.plan.milestones.map((m) => ({ id: m.id, title: m.title, due: m.due })),
  history: [{ role: 'student', text: said }],
});

console.log('=== system ===');
console.log(messages.system);
console.log('\n=== user（截取目标清单那一段）===');
console.log(
  messages.user
    .split('\n')
    .filter((l) => l.includes('目标') || l.startsWith('- ') || l.includes('今天是'))
    .join('\n')
);

const res = await completeJson(provider, TalkOutput, messages, { retries: 1 });
if (!res.ok) {
  console.log(`\n✗ 模型调用失败：${res.error}`);
  process.exit(1);
}

console.log('\n=== 模型给的 proposals 原文 ===');
console.log(JSON.stringify(res.value.proposals, null, 2));

console.log('\n=== 逐条把关结果 ===');
for (const raw of res.value.proposals) {
  const r = resolveTalkOutput(
    TalkOutput.parse({ understanding: 'x', proposals: [raw] }),
    parsed.plan,
    TODAY
  );
  const kind = raw && typeof raw === 'object' && 'kind' in raw ? String(raw.kind) : '(没有 kind)';
  console.log(r.proposals.length ? `  ✓ ${kind} 通过` : `  ✗ ${kind} 被丢掉 → ${r.refusals.join(' / ') || '（schema 就不合法，没有理由）'}`);
}
