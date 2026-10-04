/**
 * 访谈与生成端点的测试。
 *
 * 重点不在「模型好的时候能跑」，而在**模型不好的时候会怎样**：
 * 调用失败、输出重复、输出悬空引用、过早喊停。这四种情况都必须
 * 回退到本地兜底并如实报告降级原因——学生不能因为网络不好就做不了访谈，
 * 也不能拿到一份过不了校验的计划。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { emptyProfile, LearnerProfile, localDraft, parsePlan, QUESTION_BANK, type QuestionSpec } from '@sp/shared';
import type { LlmProvider } from '@sp/llm-client';
import { buildApp } from './app.ts';
import type { ServerConfig } from './config.ts';

const TODAY = '2026-10-19';
const config: ServerConfig = { port: 0, host: '127.0.0.1', llm: null };

/** 依次返回给定文本的 provider。用尽后重复最后一条 */
function scripted(texts: string[]): LlmProvider & { calls: number } {
  const p = {
    name: 'mock',
    calls: 0,
    async complete() {
      const t = texts[Math.min(p.calls, texts.length - 1)] ?? '';
      p.calls++;
      return t;
    },
  };
  return p;
}

/** 永远抛错的 provider，模拟断网 / 额度耗尽 */
const broken: LlmProvider = {
  name: 'broken',
  async complete(): Promise<string> {
    throw new Error('连接被重置');
  },
};

const makeApp = (provider: LlmProvider | null): Promise<FastifyInstance> =>
  buildApp(config, provider, { logger: false });

/** 一份完整档案，用于「模型可以收工」的场景 */
const fullProfile = () =>
  LearnerProfile.parse({
    goalStatement: '把动态规划练到能独立写出来',
    deadline: '2027-04-11',
    level: 'intermediate',
    weeklyHours: 6,
    weekdays: ['wed', 'sat'],
    weakSpots: ['动态规划'],
  });

/** 一个合法的题，用于模型出题的场景 */
const goodQuestion = (id: string) => ({
  id,
  kind: 'text' as const,
  prompt: '你平时用什么语言写题？',
  why: '语言会影响题单的选择。',
});

/* ------------------------------------------------------------------ *
 * POST /interview/next
 * ------------------------------------------------------------------ */

describe('POST /interview/next', () => {
  it('未配置 LLM 时按本地题库顺序出题，并如实报告来源', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.source, 'local');
    assert.equal(body.done, false);
    assert.equal(body.question.id, QUESTION_BANK[0]!.id);
    assert.match(body.note, /未配置 LLM/);
    await app.close();
  });

  it('问完题库后 done 为 true，不再出题', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: fullProfile(), asked: QUESTION_BANK },
    });
    const body = res.json();
    assert.equal(body.done, true);
    assert.equal(body.question, null);
    await app.close();
  });

  it('模型出了合格的题就用它', async () => {
    const provider = scripted([JSON.stringify({ done: false, question: goodQuestion('q_lang') })]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [] },
    });
    const body = res.json();
    assert.equal(body.source, 'llm');
    assert.equal(body.question.id, 'q_lang');
    await app.close();
  });

  it('模型出了重复的题 → 回退本地题库，不把重复题推给学生', async () => {
    const provider = scripted([JSON.stringify({ done: false, question: goodQuestion('q_goal') })]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [QUESTION_BANK[0]] },
    });
    const body = res.json();
    assert.equal(body.source, 'local');
    assert.notEqual(body.question.id, 'q_goal');
    assert.match(body.note, /不合格/);
    await app.close();
  });

  it('只有 1 个选项的单选被挡下（那是个渲染不出东西的空壳）', async () => {
    const provider = scripted([
      JSON.stringify({
        done: false,
        question: { id: 'q_bad', kind: 'single', prompt: '选一个', why: '因为', options: [{ value: 'a', label: 'A' }] },
      }),
    ]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [] },
    });
    assert.equal(res.json().source, 'local');
    await app.close();
  });

  it('模型调用失败 → 回退本地题库，访谈仍然走得下去', async () => {
    const app = await makeApp(broken);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [] },
    });
    assert.equal(res.statusCode, 200, '模型挂了不能让访谈跟着挂');
    const body = res.json();
    assert.equal(body.source, 'local');
    assert.equal(body.done, false);
    assert.ok(body.question);
    assert.match(body.note, /回退到本地题库/);
    await app.close();
  });

  it('模型过早喊停、关键信息还缺一半以上时不认，继续补问', async () => {
    const provider = scripted([JSON.stringify({ done: true })]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [] },
    });
    const body = res.json();
    assert.equal(body.done, false, '空档案下不该结束访谈');
    assert.ok(body.question);
    assert.match(body.note, /继续补问/);
    await app.close();
  });

  it('档案齐全时模型说结束就结束', async () => {
    const provider = scripted([JSON.stringify({ done: true })]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: fullProfile(), asked: [QUESTION_BANK[0]!] },
    });
    const body = res.json();
    assert.equal(body.done, true);
    assert.equal(body.source, 'llm');
    await app.close();
  });

  it('useLlm=false 时客户端可以主动要求降级', async () => {
    const provider = scripted([JSON.stringify({ done: false, question: goodQuestion('q_lang') })]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/interview/next',
      payload: { profile: emptyProfile(), asked: [], useLlm: false },
    });
    const body = res.json();
    assert.equal(body.source, 'local');
    assert.match(body.note, /客户端要求降级/);
    await app.close();
  });
});

/* ------------------------------------------------------------------ *
 * POST /plan/draft
 * ------------------------------------------------------------------ */

const draftJson = (p = fullProfile()) => JSON.stringify(localDraft(p, TODAY));

describe('POST /plan/draft', () => {
  it('未配置 LLM 时用本地生成，返回的文本能被重新解析且无 error', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.source, 'local');
    assert.ok(body.plan.length > 0);

    const parsed = parsePlan(body.plan);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
    if (parsed.ok) {
      assert.equal(parsed.plan.version, 1);
      assert.ok(parsed.plan.tasks.length > 0);
      assert.deepEqual(parsed.plan.reviews, []);
    }
    await app.close();
  });

  it('模型给出合法草稿时用它，并报告来源为 llm', async () => {
    const provider = scripted([draftJson()]);
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    const body = res.json();
    assert.equal(body.source, 'llm');
    assert.equal(body.repaired, 0);
    assert.equal(parsePlan(body.plan).ok, true);
    await app.close();
  });

  it('草稿有悬空引用时触发定点修复：第二轮修好后采用，并报告修了几轮', async () => {
    const bad = localDraft(fullProfile(), TODAY);
    const dangling = JSON.stringify({
      ...bad,
      tasks: bad.tasks.map((t, i) => (i === 0 ? { ...t, dependsOn: ['t_not_exist'] } : t)),
    });
    const provider = scripted([dangling, draftJson()]);

    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    const body = res.json();
    assert.equal(provider.calls, 2, '应当只请求两次：一次原始、一次修复');
    assert.equal(body.source, 'llm');
    assert.equal(body.repaired, 1);
    assert.equal(parsePlan(body.plan).ok, true);
    await app.close();
  });

  it('模型一直不合法 → 用完修复轮后改用本地生成，且不返回坏计划', async () => {
    const bad = localDraft(fullProfile(), TODAY);
    const dangling = JSON.stringify({
      ...bad,
      tasks: bad.tasks.map((t, i) => (i === 0 ? { ...t, dependsOn: ['t_not_exist'] } : t)),
    });
    const provider = scripted([dangling]);

    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.source, 'local');
    assert.match(body.note, /仍不合校验/);
    assert.equal(parsePlan(body.plan).ok, true, '兜底也必须产出合法计划');
    await app.close();
  });

  it('模型调用失败 → 本地生成，不返回 500', async () => {
    const app = await makeApp(broken);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.source, 'local');
    assert.match(body.note, /模型调用失败/);
    assert.equal(parsePlan(body.plan).ok, true);
    await app.close();
  });

  it('空档案也能生成一份合法计划——学生全跳过不等于做不下去', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: emptyProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(parsePlan(body.plan).ok, true);
    await app.close();
  });

  it('生成的计划能被 /plan/review 接住——闭环不能只在自己这一步成立', async () => {
    const app = await makeApp(null);
    const drafted = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    const planText = drafted.json().plan as string;

    const reviewed = await app.inject({
      method: 'POST',
      url: '/plan/review',
      payload: { plan: planText, today: TODAY, useLlm: false },
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body.slice(0, 300));
    const view = reviewed.json().view;
    assert.ok(typeof view.narrative === 'string' && view.narrative.length > 0);
    assert.ok(Array.isArray(view.adjustments));
    await app.close();
  });

  it('生成的计划能被 /plan/apply 应用（即使这次没有可应用的调整）', async () => {
    const app = await makeApp(null);
    const drafted = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    const planText = drafted.json().plan as string;

    const applied = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: { plan: planText, today: TODAY, at: `${TODAY}T11:00:00+08:00` },
    });
    assert.ok([200, 422].includes(applied.statusCode), `意外状态码 ${applied.statusCode}`);
    if (applied.statusCode === 200) {
      assert.equal(applied.json().ok, true);
      assert.equal(parsePlan(applied.json().plan).ok, true);
    }
    await app.close();
  });

  it('请求体里的 today 决定排期起点，不会被服务端真实日期覆盖', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, at: `${TODAY}T10:00:00+08:00` },
    });
    const parsed = parsePlan(res.json().plan);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    for (const t of parsed.plan.tasks) {
      if (t.scheduledFor) assert.ok(t.scheduledFor >= TODAY, `${t.id} 排到了 ${t.scheduledFor}，早于指定的今天`);
    }
    await app.close();
  });

  it('id 不合法时返回 400，而不是生成一份 id 坏掉的计划', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile: fullProfile(), today: TODAY, id: 'Plan-With-Dashes' },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});
