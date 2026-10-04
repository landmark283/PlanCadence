/**
 * 工具调用层的测试。
 *
 * 这一层最要紧的不是「能不能找到东西」，而是**它说的话是不是真的**：
 *   · 库里每条网址都得是 https、都得人工核过——编一个出来就是撒谎
 *   · 赛事那几条**不能有截止日**——我们没有可靠来源，写上去就是编
 *   · 库里的条目和实时抓回来的必须能靠 `source` 区分开
 * 这三条都有测试盯着。
 *
 * 其次是「按任务挂资源」不能把兜底组乱塞：那会让 `limit` 被泛泛的入口撑满，
 * 真正相关的那几条反而进不来。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Resource, validatePlan } from '../plan/schema.ts';
import { LearnerProfile, emptyProfile } from '../llm/interview.ts';
import { assemblePlan, localDraft, withToolResources, type DraftOutput } from '../llm/planner.ts';
import { FALLBACK_IDS, LIBRARY, LIBRARY_SNAPSHOT, LIBRARY_SOURCE, isLiveSource, isSnapshotSource } from './library.ts';
import { attachPlanResources, localContestFeed, mergeResources, searchResources, toResource } from './retrieve.ts';

const TODAY = '2026-10-19';

const draftOf = (tasks: { id: string; title: string }[]): DraftOutput => ({
  goal: { statement: 'x', successCriteria: [], deadline: null, priority: 'medium' },
  constraints: { weeklyMinutes: 300, availableSlots: [], maxSessionMinutes: 90, blackouts: [] },
  competences: [],
  milestones: [],
  tasks: tasks.map((t) => ({
    id: t.id,
    title: t.title,
    milestoneId: null,
    dependsOn: [],
    estimateMin: 45,
    type: 'practice' as const,
    status: 'todo' as const,
    scheduledFor: null,
    pinned: false,
    notBefore: null,
    actualMin: null,
    difficulty: null,
    resourceIds: [],
    notes: '',
  })),
  resources: [],
});

describe('资料库本身', () => {
  it('每条网址都是 https 且不重复', () => {
    const urls = LIBRARY.map((e) => e.url);
    for (const e of LIBRARY) {
      assert.ok(e.url.startsWith('https://'), `${e.id} 不是 https：${e.url}`);
    }
    assert.equal(new Set(urls).size, urls.length, '有重复网址');
    assert.equal(new Set(LIBRARY.map((e) => e.id)).size, LIBRARY.length, '有重复 id');
  });

  it('每条都有标签，否则永远匹配不上，等于一条死数据', () => {
    for (const e of LIBRARY) {
      assert.ok(e.tags.length > 0, `${e.id} 没有标签`);
      for (const t of e.tags) assert.equal(t, t.toLowerCase(), `${e.id} 的标签 ${t} 不是小写`);
    }
  });

  it('兜底组里的 id 都真实存在', () => {
    for (const id of FALLBACK_IDS) {
      assert.ok(LIBRARY.some((e) => e.id === id), `兜底 id ${id} 在库里不存在`);
    }
  });

  it('赛事条目**没有截止日**——没有可靠来源就不许填', () => {
    const contests = LIBRARY.filter((e) => e.kind === 'contest');
    assert.ok(contests.length >= 3, '至少要有蓝桥杯 / CCPC / ICPC 三个入口');
    for (const c of localContestFeed()) {
      assert.equal(c.resource.deadline, null, `${c.resource.id} 填了截止日，而我们没有来源`);
    }
  });

  it('库条目的 source 明确写成快照，和实时抓取区分得开', () => {
    assert.notEqual(LIBRARY_SOURCE, 'codeforces.com/api');
    assert.ok(LIBRARY_SOURCE.includes(LIBRARY_SNAPSHOT), 'source 里应带上快照日期');
    for (const e of LIBRARY) {
      const r = toResource(e);
      assert.equal(r.source, LIBRARY_SOURCE);
      assert.ok(r.verifiedAt?.startsWith(LIBRARY_SNAPSHOT), 'verifiedAt 应是快照日期');
      // 必须真的能过 schema：库里写错一个字段，挂到计划上时才炸就太晚了
      assert.equal(Resource.safeParse(r).success, true, `${e.id} 产出的资源不合 schema`);
    }
  });
});

describe('检索', () => {
  it('「动态规划」优先给出 DP 专用条目，而不是泛泛的算法入口', () => {
    // 取全量再比顺序：只比前 4 条的话，「泛泛的入口没进前 4」会伪装成排序正确
    const ids = searchResources('动态规划', { limit: 99 }).map((h) => h.resource.id);
    assert.ok(ids.length > 0);

    // 这条曾经真的错过：专页和通用课程命中同一个标签、得分打平，
    // 按 id 排序后泛泛的那条排到了前面。区别靠 `topic`（主要讲什么）拉开
    assert.equal(ids[0], 'res_oiwiki_dp', `DP 专页没排第一：${ids.join(' → ')}`);

    // 命中同一个标签的「顺带覆盖」类条目必须排在专页后面
    const specific = ids.indexOf('res_oiwiki_dp');
    for (const broad of ['res_acwing', 'res_cpalgo']) {
      const at = ids.indexOf(broad);
      if (at >= 0) assert.ok(specific < at, `${broad} 排在专页前面了：${ids.join(' → ')}`);
    }
  });

  it('每条库条目都填了 topic——它是和「顺手匹配上」区分开的唯一依据', () => {
    for (const e of LIBRARY) assert.ok(e.topic && e.topic.length > 0, `${e.id} 没填 topic`);
  });

  it('英文缩写也能命中（学生自己就写 DFS/BFS）', () => {
    const ids = searchResources('DFS/BFS 模板默写 + 5 道水题').map((h) => h.resource.id);
    assert.ok(ids.includes('res_oiwiki_search'), `期望命中搜索条目，实际 ${ids.join(',')}`);
  });

  it('一条都没命中时给兜底组——空面板会让学生以为系统坏了', () => {
    const hits = searchResources('今天天气不错');
    assert.ok(hits.length > 0);
    for (const h of hits) assert.ok(FALLBACK_IDS.includes(h.resource.id));
  });

  it('fallback:false 时一条都没命中就老实返回空', () => {
    assert.deepEqual(searchResources('今天天气不错', { fallback: false }), []);
  });

  it('水平不够的条目会被过滤掉', () => {
    // Codeforces / AtCoder 都要求 basic 起
    const ids = searchResources('练习 刷题 比赛', { level: 'beginner', fallback: false }).map((h) => h.resource.id);
    assert.ok(!ids.includes('res_cf_problemset'), '初学者不该被推 Codeforces 题单');
    assert.ok(!ids.includes('res_atcoder'));
    const ids2 = searchResources('练习 刷题 比赛', { level: 'intermediate', fallback: false }).map((h) => h.resource.id);
    assert.ok(ids2.includes('res_cf_problemset'), '中级应该推得到');
  });

  it('exclude 里的 id 不会再出现', () => {
    const hits = searchResources('动态规划', { exclude: ['res_oiwiki_dp'] });
    assert.ok(!hits.some((h) => h.resource.id === 'res_oiwiki_dp'));
  });

  it('同样的输入跑两次结果完全一样（可复现，不是随机）', () => {
    const a = searchResources('图论 最短路').map((h) => h.resource.id);
    const b = searchResources('图论 最短路').map((h) => h.resource.id);
    assert.deepEqual(a, b);
  });
});

describe('挂到任务上', () => {
  const profile = LearnerProfile.parse({ weakSpots: ['动态规划'], level: 'basic', goalStatement: '省一' });

  it('相关任务挂上对应资源，links 里只含真的进了池的 id', () => {
    const tasks = [
      { id: 't_01', title: '通读「动态规划」的核心概念' },
      { id: 't_02', title: '「动态规划」模板题 3 道' },
    ];
    const out = attachPlanResources({ tasks, profile });
    assert.ok(out.resources.length > 0);
    const pool = new Set(out.resources.map((r) => r.id));
    for (const l of out.links) {
      for (const id of l.resourceIds) assert.ok(pool.has(id), `link 指向了池外的 ${id}`);
    }
    assert.ok(out.links.length > 0, '有相关任务却没挂上任何资源');
  });

  it('**不相关的任务不会被塞兜底资源**（否则 limit 会被泛泛入口撑满）', () => {
    const tasks = [
      { id: 't_01', title: '把书翻到第 3 章' },
      { id: 't_02', title: '整理一下桌面' },
    ];
    const out = attachPlanResources({ tasks, profile });
    for (const l of out.links) {
      for (const id of l.resourceIds) {
        assert.ok(!FALLBACK_IDS.includes(id), `不相关任务被塞了兜底资源 ${id}`);
      }
    }
  });

  it('没有任务也没有薄弱点时，仍然给一组通用入口而不是空手而归', () => {
    const out = attachPlanResources({ tasks: [], profile: emptyProfile() });
    assert.ok(out.resources.length > 0, '空档案不该拿到空资源面板');
  });

  it('extra（实时抓回的赛事）会进池', () => {
    const live = Resource.parse({
      id: 'res_cf_2261',
      title: 'Codeforces Round 1125',
      url: 'https://codeforces.com/contest/2261',
      kind: 'contest',
      verifiedAt: `${TODAY}T20:00:00+08:00`,
      source: 'codeforces.com/api',
      deadline: '2026-11-05',
    });
    const out = attachPlanResources({ tasks: [], profile, extra: [live] });
    assert.ok(out.resources.some((r) => r.id === 'res_cf_2261'));
  });

  it('「是不是实时抓的」只认显式列出的来源，不靠「不是快照」推断', () => {
    // 演示夹具里有一条来自「校内通知」的静态数据。用「不是快照 ⇒ 实时」
    // 去判断的话，它会被标成「实时」——那是在替一份静态数据撒谎
    assert.equal(isLiveSource('codeforces.com/api'), true);
    assert.equal(isLiveSource('校内通知'), false);
    assert.equal(isLiveSource(undefined), false);
    assert.equal(isSnapshotSource(LIBRARY_SOURCE), true);
    assert.equal(isLiveSource(LIBRARY_SOURCE), false);
    // 实时来源必须和库的标识长得不一样，否则界面无从区分
    assert.ok(!isSnapshotSource('codeforces.com/api'));
  });
});

describe('把资源挂进草稿', () => {
  it('模型的 resources 一律丢掉，并且**报出丢了几条**', () => {
    const draft = draftOf([{ id: 't_01', title: '通读「动态规划」的核心概念' }]);
    const withFake = {
      ...draft,
      resources: [
        { id: 'r_model', title: '模型编的资料', url: 'https://example.com/404', kind: 'article' as const },
      ],
    };
    const res = withToolResources(withFake as DraftOutput, LearnerProfile.parse({ weakSpots: ['动态规划'] }));
    assert.equal(res.droppedModelResources, 1);
    assert.ok(!res.draft.resources.some((r) => r.id === 'r_model'), '模型编的 URL 不该留下');
  });

  it('被丢掉的模型资源，它在任务上的引用也要清掉，否则是悬空引用', () => {
    const draft = draftOf([{ id: 't_01', title: '整理桌面' }]);
    const withRef = {
      ...draft,
      tasks: [{ ...draft.tasks[0]!, resourceIds: ['r_model'] }],
      resources: [{ id: 'r_model', title: 'x', url: 'https://example.com/x', kind: 'article' as const }],
    };
    const res = withToolResources(withRef as DraftOutput, emptyProfile());
    assert.deepEqual(res.draft.tasks[0]?.resourceIds, []);
  });

  it('挂完资源之后，整份计划仍然过得了 validatePlan', () => {
    const profile = LearnerProfile.parse({
      goalStatement: '明年四月能独立做出省赛中等难度的题',
      deadline: '2027-04-11',
      weakSpots: ['动态规划', '图赛'],
      weeklyHours: 6,
      weekdays: ['wed', 'sat'],
      level: 'basic',
    });
    const built = assemblePlan(localDraft(profile, TODAY), { id: 'plan_t', now: `${TODAY}T10:00:00+08:00`, title: 't', profile });
    assert.equal(built.ok, true, built.ok ? '' : built.error);

    const errors = validatePlan(built.plan).filter((i) => i.level === 'error');
    assert.deepEqual(errors, []);
    // 断网路径也**必须有真资源**，否则演示时资源页是空的
    assert.ok(built.plan.resources.length > 0, '本地兜底路径的资源是空的');
    const pool = new Set(built.plan.resources.map((r) => r.id));
    for (const t of built.plan.tasks) {
      for (const id of t.resourceIds) assert.ok(pool.has(id), `任务 ${t.id} 引用了不存在的资源 ${id}`);
    }
  });
});

describe('mergeResources', () => {
  const mk = (id: string, url: string) => Resource.parse({ id, title: id, url, kind: 'article' });

  it('按 url 去重，先给的优先（所以库里的要放在前面）', () => {
    const merged = mergeResources([mk('res_lib', 'https://a.com/')], [mk('r_model', 'https://a.com/')]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.id, 'res_lib');
  });

  it('id 撞了但网址不同时改 id，而不是丢掉这条资源', () => {
    const merged = mergeResources([mk('dup', 'https://a.com/')], [mk('dup', 'https://b.com/')]);
    assert.equal(merged.length, 2);
    assert.equal(new Set(merged.map((r) => String(r.id))).size, 2, 'id 必须唯一');
  });
});
