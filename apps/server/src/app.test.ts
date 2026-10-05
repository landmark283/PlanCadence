/**
 * 路由测试：用 `app.inject()` 打真实路由，不占端口、不起进程。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOpenAiCompatProvider } from '@sp/llm-client';
import type { LlmProvider } from '@sp/llm-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import type { ServerConfig } from './config.ts';

const DEMO = fileURLToPath(new URL('../../../examples/demo.studyplan', import.meta.url));
const planText = fs.readFileSync(DEMO, 'utf8');

/**
 * 示例文件的版本号，从文件里读出来而不是写死。
 *
 * 原来这里硬编码了 v4，于是任何人正当地编辑示例文件（补任务、用 CLI 演练）
 * 都会让这两条测试变红。测试一旦因为「内容变了」而不是「行为变了」失败，
 * 大家就会开始忽略它——那就等于没有测试。
 */
const DEMO_VERSION = Number(/^version:\s*(\d+)\s*$/m.exec(planText)?.[1]);
if (!Number.isInteger(DEMO_VERSION)) throw new Error('无法从 examples/demo.studyplan 读出 version');

const TODAY = '2026-10-19';
/** 示例文件的 meta.updated 是 2026-10-19T21:45:00+08:00，apply 的 at 必须晚于它 */
const AFTER = '2026-10-20T10:00:00+08:00';

const config: ServerConfig = { port: 0, host: '127.0.0.1', llm: null, today: null, tz: 'Asia/Shanghai' };

/** 固定返回一段文本的 provider */
function canned(text: string): LlmProvider & { calls: number } {
  const p = {
    name: 'mock',
    calls: 0,
    async complete() {
      p.calls++;
      return text;
    },
  };
  return p;
}

const validAdvisor = (taskIds: string[], options: string[] = []) =>
  JSON.stringify({
    narrative: '这周有几处需要调整，我先说结论。',
    reasons: taskIds.map((id) => ({ taskId: id, reason: `模型给 ${id} 的理由` })),
    cautions: ['背包这块你在笔记里说还是混，建议先补一个小练习。'],
    recommendedOptions: options,
  });

async function makeApp(provider: LlmProvider | null): Promise<FastifyInstance> {
  return buildApp(config, provider, { logger: false });
}

describe('GET /', () => {
  it('根路径返回端点清单——避免浏览器打开时被裸 404 误导成「后端挂了」', async () => {
    const app = await makeApp(null);
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200, '根路径必须是 200，不能是 404');
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.llm.configured, false);
    assert.ok(Object.keys(body.endpoints).length >= 4);
    await app.close();
  });

  it('根路径同样不泄露密钥', async () => {
    const provider = createOpenAiCompatProvider({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-ROOT-MUST-NOT-LEAK',
      model: 'demo-model',
    });
    const app = await makeApp(provider);
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.ok(res.body.includes('openai-compat:demo-model'));
    assert.ok(!res.body.includes('sk-ROOT-MUST-NOT-LEAK'));
    await app.close();
  });
});

describe('GET /health', () => {
  it('未配置 LLM 时如实报告', async () => {
    const app = await makeApp(null);
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.schema, 'studyplan/v1');
    assert.equal(body.llm.configured, false);
    await app.close();
  });

  it('配置 LLM 时报告模型名，且不泄露密钥', async () => {
    const provider = createOpenAiCompatProvider({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-MUST-NOT-LEAK',
      model: 'demo-model',
    });
    const app = await makeApp(provider);
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const raw = res.body;
    assert.ok(raw.includes('openai-compat:demo-model'), '应报告模型名');
    assert.ok(!raw.includes('sk-MUST-NOT-LEAK'), '密钥绝不能出现在响应里');
    await app.close();
  });
});

describe('POST /plan/validate', () => {
  it('合法文件返回概要', async () => {
    const app = await makeApp(null);
    const res = await app.inject({ method: 'POST', url: '/plan/validate', payload: { plan: planText } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.id, 'plan_czw01');
    assert.ok(body.tasks > 0);
    await app.close();
  });

  it('缺 plan 字段返回 400', async () => {
    const app = await makeApp(null);
    const res = await app.inject({ method: 'POST', url: '/plan/validate', payload: {} });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('格式错误返回 400 并带结构化问题', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/validate',
      payload: { plan: 'schema: studyplan/v1\nversion: 1\n' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
    await app.close();
  });
});

describe('POST /plan/review', () => {
  it('无 provider 时走引擎措辞', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/review',
      payload: { plan: planText, today: TODAY },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.view.narrativeSource, 'engine');
    assert.ok(body.report.adjustments.length > 0);
    assert.match(body.note, /未配置 LLM/);
    await app.close();
  });

  it('provider 返回合法 JSON 时用 LLM 措辞', async () => {
    const app = await makeApp(null);
    // 先跑一次拿到真实的 taskId 集合，再据此构造模型的回答
    const first = await app.inject({ method: 'POST', url: '/plan/review', payload: { plan: planText, today: TODAY } });
    const ids: string[] = first.json().view.adjustments.map((a: { taskId: string }) => a.taskId);
    await app.close();

    const provider = canned(validAdvisor(ids));
    const app2 = await makeApp(provider);
    const res = await app2.inject({ method: 'POST', url: '/plan/review', payload: { plan: planText, today: TODAY } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.view.narrativeSource, 'llm');
    assert.equal(body.view.adjustments[0].llmReason, `模型给 ${ids[0]} 的理由`);
    assert.deepEqual(body.view.dropped, { reasons: 0, options: 0 });
    await app2.close();
  });

  it('模型输出全是垃圾时降级，但请求仍然成功——复盘功能不能跟着模型一起挂', async () => {
    const provider = canned('抱歉，我今天不想工作。');
    const app = await makeApp(provider);
    const res = await app.inject({ method: 'POST', url: '/plan/review', payload: { plan: planText, today: TODAY } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.view.narrativeSource, 'engine');
    assert.match(body.note, /降级/);
    assert.equal(provider.calls, 2, '应该重试过一次');
    await app.close();
  });

  it('模型编造 taskId 时丢弃该条，其余照常展示', async () => {
    const provider = canned(validAdvisor(['t_根本不存在']));
    const app = await makeApp(provider);
    const res = await app.inject({ method: 'POST', url: '/plan/review', payload: { plan: planText, today: TODAY } });
    const body = res.json();
    assert.equal(body.view.narrativeSource, 'llm', '综述有效，不该整体降级');
    assert.equal(body.view.dropped.reasons, 1);
    for (const a of body.view.adjustments) assert.equal(a.llmReason, null);
    await app.close();
  });

  it('模型推荐引擎没给出的协商选项时，该选项被丢弃', async () => {
    // 示例计划只有 1 次复盘，按设计引擎不会给出任何目标协商选项。
    // 模型自作主张推荐「deepen」时，必须被裁掉——否则学生会看到一个
    // 依据不存在的选项，而后端根本给不出对应的影响与后果。
    const provider = canned(validAdvisor([], ['deepen', 'accelerate']));
    const app = await makeApp(provider);
    const res = await app.inject({ method: 'POST', url: '/plan/review', payload: { plan: planText, today: TODAY } });
    const body = res.json();
    assert.equal(body.view.dropped.options, 2);
    assert.deepEqual(body.view.recommendedOptions, []);
    await app.close();
  });

  it('useLlm:false 时即使配了 provider 也走引擎', async () => {
    const provider = canned(validAdvisor([]));
    const app = await makeApp(provider);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/review',
      payload: { plan: planText, today: TODAY, useLlm: false },
    });
    assert.equal(res.json().view.narrativeSource, 'engine');
    assert.equal(provider.calls, 0, '不该调用模型');
    await app.close();
  });

  it('非法 today 返回 400', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/review',
      payload: { plan: planText, today: '2026/10/19' },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

describe('POST /plan/apply', () => {
  it('返回新文件文本，版本 +1，且能被重新解析', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: { plan: planText, today: TODAY, at: AFTER },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.applied > 0);
    assert.equal(body.version, DEMO_VERSION + 1, `示例是 v${DEMO_VERSION}，应用后应为 v${DEMO_VERSION + 1}`);

    // 返回的文本必须能再次解析——否则客户端一落盘就损坏了
    const check = await app.inject({ method: 'POST', url: '/plan/validate', payload: { plan: body.plan } });
    assert.equal(check.statusCode, 200);
    assert.equal(check.json().version, DEMO_VERSION + 1);
    await app.close();
  });

  it('只应用学生勾选的那几条', async () => {
    const app = await makeApp(null);
    const review = await app.inject({ method: 'POST', url: '/plan/review', payload: { plan: planText, today: TODAY } });
    const ids: string[] = review.json().view.adjustments.map((a: { taskId: string }) => a.taskId);
    assert.ok(ids.length >= 2, '需要至少两条调整才能验证挑选');

    const res = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: { plan: planText, today: TODAY, at: AFTER, accepted: [ids[0]] },
    });
    assert.equal(res.json().applied, 1);
    await app.close();
  });

  it('accepted 为空数组时不改动任何东西', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: { plan: planText, today: TODAY, at: AFTER, accepted: [] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.applied, 0);
    assert.equal(body.version, DEMO_VERSION);
    assert.equal(body.plan, planText, '应原样返回');
    await app.close();
  });

  it('时间戳早于 meta.updated 不再被拒绝（这条守卫已被删掉）', async () => {
    // 调试模式把日期往回拨之后，客户端发出来的 at 就会早于 meta.updated。
    // 一旦这条守卫复活，那种情况下每一次改动都会被 409 挡掉，
    // 而界面表现只是「点了没反应」——查起来极其费劲。
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: { plan: planText, today: TODAY, at: '2026-10-01T10:00:00+08:00' },
    });
    assert.equal(res.statusCode, 200, '不该是 409');
    assert.ok(res.json().applied > 0);
    await app.close();
  });

  it('可写入学生填写的复盘记录', async () => {
    const app = await makeApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: {
        plan: planText,
        today: TODAY,
        at: AFTER,
        review: { plannedTasks: 3, completedTasks: 2, loadFeedback: 0.6, notes: '背包还是有点混' },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().plan.includes('背包还是有点混'), '复盘备注应写进文件');
    await app.close();
  });

  it('没有调整可应用时原样返回，且不报错', async () => {
    const app = await makeApp(null);
    // 找一个不会产生调整的 today：把基准日放在所有任务之后
    const res = await app.inject({
      method: 'POST',
      url: '/plan/apply',
      payload: { plan: planText, today: '2027-06-01', at: '2027-06-01T10:00:00+08:00' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.applied >= 0);
    await app.close();
  });
});
