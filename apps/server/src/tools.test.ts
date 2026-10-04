/**
 * 工具调用端点的测试。
 *
 * 这一层有两件事一定会出问题，测试主要就是盯着它们：
 *
 * 1. **实时抓取一定会失败**（现场断网、接口限流、对方改字段）。
 *    所以 `fetchCodeforcesContests` 在任何情况下都**不许抛异常**，
 *    必须返回空数组加一句人话原因——生成计划不能因为拉赛程失败就一起失败。
 * 2. **单条坏数据不能拖垮整批**。接口返回的形状说变就变，
 *    一条解析不了的场次不该让其余几条也进不来。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { LearnerProfile, localDraft, parsePlan, validatePlan } from '@sp/shared';
import { buildApp } from './app.ts';
import type { ServerConfig } from './config.ts';
import { fetchCodeforcesContests } from './tools/codeforces.ts';

const TODAY = '2026-10-19';
const config: ServerConfig = { port: 0, host: '127.0.0.1', llm: null };
const makeApp = (): Promise<FastifyInstance> => buildApp(config, null, { logger: false });

/** 造一个假的 fetch，只回一个响应 */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const cfPayload = {
  status: 'OK',
  result: [
    { id: 3, name: '已结束的场次', phase: 'FINISHED', startTimeSeconds: 1_700_000_000, durationSeconds: 7200 },
    { id: 2, name: 'Codeforces Round 999 (Div. 2)', phase: 'BEFORE', startTimeSeconds: 1_810_000_000, durationSeconds: 7200 },
    { id: 1, name: 'Codeforces Round 998 (Div. 3)', phase: 'BEFORE', startTimeSeconds: 1_800_000_000, durationSeconds: 8100 },
  ],
};
describe('fetchCodeforcesContests', () => {
  it('只取未开赛的场次，按开赛时间从近到远', async () => {
    const r = await fetchCodeforcesContests({ fetchImpl: fakeFetch(cfPayload), today: TODAY });
    assert.equal(r.contests.length, 2, '已结束的场次不该进来');
    assert.deepEqual(r.contests.map((c) => c.id), ['res_cf_1', 'res_cf_2'], '近的排前面');
  });

  it('抓回来的每条都带真实开赛日、校验时间和来源', async () => {
    const r = await fetchCodeforcesContests({ fetchImpl: fakeFetch(cfPayload), today: TODAY });
    const c = r.contests[0]!;
    assert.match(c.url, /^https:\/\/codeforces\.com\/contest\/\d+$/);
    assert.equal(c.kind, 'contest');
    assert.equal(c.source, 'codeforces.com/api');
    assert.ok(c.verifiedAt, '没有校验时间的资源没法证明是刚抓的');
    assert.match(c.deadline ?? '', /^\d{4}-\d{2}-\d{2}$/, '赛事必须带开赛日，否则卡片没有倒计时');
  });

  it('limit 生效', async () => {
    const r = await fetchCodeforcesContests({ fetchImpl: fakeFetch(cfPayload), today: TODAY, limit: 1 });
    assert.equal(r.contests.length, 1);
  });

  it('**网络出错时不抛异常**，返回空数组 + 人话原因', async () => {
    const boom = (async () => {
      throw new Error('连接被重置');
    }) as unknown as typeof fetch;
    const r = await fetchCodeforcesContests({ fetchImpl: boom, today: TODAY });
    assert.deepEqual(r.contests, []);
    assert.match(r.note, /连接被重置/);
  });

  it('HTTP 非 2xx 也不抛，带状态码说明', async () => {
    const r = await fetchCodeforcesContests({ fetchImpl: fakeFetch({}, { ok: false, status: 503 }), today: TODAY });
    assert.deepEqual(r.contests, []);
    assert.match(r.note, /503/);
  });

  it('返回结构变了也不抛——对方改字段是迟早的事', async () => {
    const r = await fetchCodeforcesContests({ fetchImpl: fakeFetch({ status: 'FAILED' }), today: TODAY });
    assert.deepEqual(r.contests, []);
    assert.match(r.note, /预期之外|没有即将开始/);
  });

  it('返回体不是 JSON 也不抛', async () => {
    const bad = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Unexpected token < in JSON');
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const r = await fetchCodeforcesContests({ fetchImpl: bad, today: TODAY });
    assert.deepEqual(r.contests, []);
    assert.ok(r.note.length > 0);
  });

  /**
   * 演示时钟比真实日期快半个月，于是**真实世界里即将开赛的场次，
   * 在演示时钟下全都成了「已截止 12 天」**——一张写着"已截止"的赛事卡
   * 看起来就像程序坏了。
   *
   * 所以开赛日早于 App 认定的今天时不给 `deadline`，但标题里保留日期。
   * 用相对时间构造，避免这条测试挑日期。
   */
  it('开赛日早于「今天」时不给 deadline，但标题里保留日期', async () => {
    const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const payload = {
      status: 'OK',
      result: [{ id: 7, name: 'Round 7', phase: 'BEFORE', startTimeSeconds: Math.floor(Date.now() / 1000) + 3 * 86_400 }],
    };
    const r = await fetchCodeforcesContests({
      fetchImpl: fakeFetch(payload),
      // 今天比开赛日晚 10 天：倒计时会是负的
      today: day(10),
    });
    assert.equal(r.contests.length, 1, '按真实时钟它还没开赛，不该被过滤掉');
    assert.equal(r.contests[0]!.deadline, null, '不该给一个会显示成"已截止"的截止日');
    assert.match(r.contests[0]!.title, /\d{4}-\d{2}-\d{2} 开赛/, '日期必须在标题里保留下来');
    assert.match(r.note, /早于当前演示日期/);
  });

  it('开赛日不早于今天时正常给 deadline（真实用户手上就是这样）', async () => {
    const payload = {
      status: 'OK',
      result: [{ id: 8, name: 'Round 8', phase: 'BEFORE', startTimeSeconds: Math.floor(Date.now() / 1000) + 10 * 86_400 }],
    };
    const r = await fetchCodeforcesContests({ fetchImpl: fakeFetch(payload), today: new Date().toISOString().slice(0, 10) });
    assert.equal(r.contests.length, 1);
    assert.match(r.contests[0]!.deadline ?? '', /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('POST /tools/resources', () => {
  it('按薄弱点检索到资料，并说明命中了哪些词', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tools/resources',
      payload: { query: '动态规划', level: 'basic' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.ok(body.resources.length > 0);
    assert.equal(body.resources[0].id, 'res_oiwiki_dp');
    assert.ok(body.matched[0].includes('动态规划'), '要说清楚按什么词找到的');
    await app.close();
  });

  it('请求体不合法返回 400，而不是 500', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/tools/resources', payload: { query: '' } });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

describe('POST /tools/contests', () => {
  it('live:false 时完全不碰网络，只给本地官网入口', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/tools/contests', payload: { live: false } });
    const body = res.json();
    assert.equal(body.live, false);
    assert.ok(body.resources.length >= 3, '蓝桥杯 / CCPC / ICPC 三个入口');
    for (const r of body.resources) {
      assert.equal(r.deadline, null, '本地库没有可靠来源，不许填截止日');
      assert.equal(r.source, '资料库快照@2026-10-19');
    }
    await app.close();
  });

  it('线上抓不到时**照样 200**，只是退回本地并把原因写在 note 里', async () => {
    // 沙箱里通常连不上 codeforces，正好覆盖这条真实的降级路径。
    // 关键在于：不能 500，也不能给一个空的赛事区还不解释
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/tools/contests', payload: { today: TODAY } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.resources.length > 0, '抓不到就退本地库，不能空手');
    assert.ok(typeof body.note === 'string' && body.note.length > 0, '必须说明为什么没有实时数据');
    await app.close();
  });
});

describe('POST /tools/attach', () => {
  it('给任务挂上资料，links 只指向真的进了池的资源', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tools/attach',
      payload: {
        weakSpots: ['动态规划'],
        level: 'basic',
        tasks: [
          { id: 't_01', title: '通读「动态规划」的核心概念' },
          { id: 't_02', title: '「动态规划」模板题 3 道' },
        ],
        live: false,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const pool = new Set(body.resources.map((r: { id: string }) => r.id));
    assert.ok(pool.size > 0);
    for (const l of body.links) {
      for (const id of l.resourceIds) assert.ok(pool.has(id), `link 指向池外的 ${id}`);
    }
    await app.close();
  });
});

describe('生成计划时会带上资源', () => {
  it('本地兜底路径产出的计划里，资源和任务挂载都是真的', async () => {
    const app = await makeApp();
    const profile = LearnerProfile.parse({
      goalStatement: '明年四月能独立做出省赛中等难度的题',
      deadline: '2027-04-11',
      weakSpots: ['动态规划'],
      weeklyHours: 6,
      level: 'basic',
    });
    // 直接走 shared 的本地路径：这条不依赖模型也不依赖网络
    const draft = localDraft(profile, TODAY);
    assert.ok(draft.resources.length > 0, '断网路径也该带得出资料');

    const res = await app.inject({
      method: 'POST',
      url: '/plan/draft',
      payload: { profile, today: TODAY, useLlm: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);

    const parsed = parsePlan(body.plan);
    assert.equal(parsed.ok, true, parsed.ok ? '' : String(parsed.error));
    if (!parsed.ok) return;
    assert.ok(parsed.plan.resources.length > 0, '生成的计划里资源是空的');
    assert.deepEqual(validatePlan(parsed.plan).filter((i) => i.level === 'error'), []);
    // 资源必须来自校验过的库，不能是模型编的
    for (const r of parsed.plan.resources) {
      assert.ok(r.url.startsWith('https://'));
      assert.ok(r.source, '每条资源都要有来源，否则没法区分实时抓的和库里的');
    }
    await app.close();
  });
});
