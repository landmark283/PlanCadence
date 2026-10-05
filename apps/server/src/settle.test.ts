/**
 * 补账叙述端点的测试。
 *
 * 这个端点唯一的承诺是：**说人话，但一个数字都不许编。**
 * 所以测试的重点全在「模型不老实的时候会怎样」：
 * 调用失败、返回垃圾、写出了事实之外的数字。
 * 三种情况都必须退回本机叙述，而不是把编出来的话发给学生——
 * 学生无从发现「9 项」被说成了「3 项」，而他会因此不再相信这个系统。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { SettleNarrativeInput } from '@sp/shared';
import type { LlmProvider } from '@sp/llm-client';
import { buildApp } from './app.ts';
import type { ServerConfig } from './config.ts';

const config: ServerConfig = { port: 0, host: '127.0.0.1', llm: null, today: null, tz: 'Asia/Shanghai' };

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

const body = (over: Partial<SettleNarrativeInput> = {}): SettleNarrativeInput => ({
  from: '2026-10-14',
  to: '2026-10-19',
  daysPassed: 5,
  doneCount: 1,
  pending: [
    { title: '复习：背包三变体', scheduledFor: '2026-10-15', blocks: 2, estimateMin: 25 },
    { title: '01 背包手推 5 遍', scheduledFor: '2026-10-16', blocks: 0, estimateMin: 60 },
    { title: '图论：最短路四算法', scheduledFor: '2026-10-17', blocks: 0, estimateMin: 45 },
  ],
  pastGoalDeadline: false,
  atRiskMilestones: [],
  goalStatement: '明年四月能独立做出省赛中等难度的题',
  localText: '距上次打开过了 5 天。这期间本该完成 3 项，都没打勾。不过你也完成了 1 项。',
  ...over,
});

const makeApp = (provider: LlmProvider | null): Promise<FastifyInstance> => buildApp(config, provider, { logger: false });

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/plan/settle', payload: payload as Record<string, unknown> });

describe('POST /plan/settle', () => {
  it('没配模型时原样返回本机叙述——这一屏断网也必须能用', async () => {
    const app = await makeApp(null);
    const res = await post(app, body());
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.equal(json.narrativeSource, 'local');
    assert.equal(json.narrative, body().localText);
    assert.match(json.note, /未配置 LLM/);
    await app.close();
  });

  it('模型只说人话时采用它', async () => {
    const app = await makeApp(canned(JSON.stringify({ narrative: '这几天有 3 项没动，其中 1 项压着后面的安排。' })));
    const json = (await post(app, body())).json();
    assert.equal(json.narrativeSource, 'llm');
    assert.match(json.narrative, /3 项/);
    await app.close();
  });

  it('模型把 3 项说成 9 项时整段退回本机叙述', async () => {
    /**
     * 这是这个端点最重要的一条测试。
     *
     * 「引擎算事实、模型只改措辞」如果只写在提示词里，是一句没有约束力的话——
     * 模型仍然会把 3 项说成 9 项，而学生**没有任何办法发现**。
     * 所以约束必须落在校验上：数字白名单对不上就整段不要。
     */
    const app = await makeApp(canned(JSON.stringify({ narrative: '这几天有 9 项还没动，情况有点多。' })));
    const json = (await post(app, body())).json();
    assert.equal(json.narrativeSource, 'local');
    assert.equal(json.narrative, body().localText);
    assert.match(json.note, /编|之外的数字/);
    await app.close();
  });

  it('模型做加法也算编数字', async () => {
    const app = await makeApp(canned(JSON.stringify({ narrative: '一共有 6 项要补，得抓紧。' })));
    const json = (await post(app, body())).json();
    assert.equal(json.narrativeSource, 'local');
    await app.close();
  });

  it('提到日期里的数字不算编——否则每一句带日期的正常叙述都会被退掉', async () => {
    const app = await makeApp(
      canned(JSON.stringify({ narrative: '从 10 月 15 日到 10 月 17 日这段，积了 3 项。' })),
    );
    const json = (await post(app, body())).json();
    assert.equal(json.narrativeSource, 'llm', `被误杀了：${json.note}`);
    await app.close();
  });

  it('模型输出不是 JSON 时降级，请求仍然成功', async () => {
    const provider = canned('我建议你重新规划一下。');
    const app = await makeApp(provider);
    const res = await post(app, body());
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().narrativeSource, 'local');
    assert.equal(provider.calls, 2, '应该重试过一次');
    await app.close();
  });

  it('模型返回空叙述时降级', async () => {
    const app = await makeApp(canned(JSON.stringify({ narrative: '' })));
    assert.equal((await post(app, body())).json().narrativeSource, 'local');
    await app.close();
  });

  it('请求体不合法返回 400，而不是 500', async () => {
    const app = await makeApp(null);
    assert.equal((await post(app, {})).statusCode, 400);
    assert.equal((await post(app, { ...body(), daysPassed: 0 })).statusCode, 400, '没有隔天就不该走到这里');
    assert.equal((await post(app, { ...body(), localText: '' })).statusCode, 400);
    await app.close();
  });

  it('提示词里只用得到「已经算好的事实」，不含任务 id', async () => {
    /**
     * 结构上的保证：模型看不到计划本身，所以它不可能重算一遍，
     * 也就不可能和界面上的清单对不上。
     */
    let seen = '';
    const spy: LlmProvider = {
      name: 'spy',
      async complete(req) {
        seen = req.messages.map((m) => m.content).join('\n');
        return JSON.stringify({ narrative: '这 5 天积了 3 项。' });
      },
    };
    const app = await makeApp(spy);
    await post(app, body());
    assert.ok(seen.includes('背包三变体'), '清单标题要给');
    assert.ok(!seen.includes('t_'), '但不该出现任何任务 id');
    await app.close();
  });
});
