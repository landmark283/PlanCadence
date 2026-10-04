/**
 * planner 的测试。
 *
 * 最重要的一组是「本地兜底在任何档案下都能产出一份合法计划」。
 * `localDraft` 不是聊胜于无的降级，它是**地板**：断网、没 Key、模型抽风时，
 * 学生仍然要拿得到一份排进自己日程、避开自己考试周的计划。
 * 一旦它产出的计划过不了 `validatePlan`，落盘那一刻就会炸——那是最糟的失败方式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePlan, type PlanFile } from '../plan/schema.ts';
import { LIBRARY, LIBRARY_SOURCE } from '../tools/library.ts';
import { emptyProfile, LearnerProfile, type LearnerProfile as Profile } from './interview.ts';
import { assemblePlan, describePlanDraft, DraftOutput, localDraft, parseDraftOutput } from './planner.ts';

const TODAY = '2026-10-19';

const assemble = (profile: Profile) =>
  assemblePlan(localDraft(profile, TODAY), { id: 'plan_test', now: `${TODAY}T10:00:00+08:00`, title: '测试计划' });

/** 一堆刁钻档案：空档案、过去截止日、零投入、考试周盖满整个地平线…… */
const NASTY: { name: string; profile: Profile }[] = [
  { name: '空档案', profile: emptyProfile() },
  {
    name: '截止日在过去',
    profile: LearnerProfile.parse({ goalStatement: '已经过期了', deadline: '2025-01-01', level: 'basic' }),
  },
  {
    name: '截止日就是今天',
    profile: LearnerProfile.parse({ deadline: TODAY, weeklyHours: 10, weekdays: ['mon'] }),
  },
  {
    name: '每周零小时',
    profile: LearnerProfile.parse({ weeklyHours: 0, weekdays: ['sat'] }),
  },
  {
    name: '没填可用日',
    profile: LearnerProfile.parse({ weeklyHours: 8, weekdays: [] }),
  },
  {
    name: '八门薄弱项',
    profile: LearnerProfile.parse({
      weakSpots: ['动态规划', '图论', '数学推导', '读题慢', '不知道从哪下手', '字符串', '数论', '贪心'],
      weeklyHours: 20,
      weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    }),
  },
  {
    name: '考试周盖满整个地平线',
    profile: LearnerProfile.parse({
      deadline: '2027-04-11',
      weeklyHours: 6,
      weekdays: ['wed', 'sat'],
      blackouts: [{ from: '2026-10-19', to: '2027-06-01', reason: '长期不可用' }],
    }),
  },
  {
    name: '每天只有 30 分钟',
    profile: LearnerProfile.parse({ weeklyHours: 1, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }),
  },
];

describe('localDraft：本地兜底必须永远产出一份合法计划', () => {
  for (const { name, profile } of NASTY) {
    it(`${name} → 过 validatePlan 且无 error`, () => {
      const r = assemble(profile);
      assert.equal(r.ok, true, r.ok ? '' : `${r.error}\n${r.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}`);
      if (!r.ok) return;
      assert.equal(validatePlan(r.plan).filter((i) => i.level === 'error').length, 0);
    });
  }

  it('至少产出一个任务——一份没有任务的"计划"等于没有计划', () => {
    const r = assemble(emptyProfile());
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.plan.tasks.length > 0);
  });

  it('资源只来自校验过的资料库，绝不自己编 URL', () => {
    // 这条原来断言的是「resources 为空」，理由是不编 URL。理由仍然成立，
    // 但现在有了一条不编 URL 也能给出资源的路：工具层从内置库取，网址都人工核过。
    // 所以断言改成**更强的**那条：给出来的每条都必须是库里的、且是 https。
    for (const { profile, name } of NASTY) {
      const d = localDraft(profile, TODAY);
      for (const r of d.resources) {
        assert.ok(r.url.startsWith('https://'), `${name}：${r.title} 的网址不是 https`);
        assert.ok(
          LIBRARY.some((e) => e.url === r.url),
          `${name}：${r.title}（${r.url}）不在资料库里，属于凭空出现`,
        );
        assert.equal(r.source, LIBRARY_SOURCE, `${name}：${r.title} 的来源标注不对`);
      }
    }
    const basic = localDraft(LearnerProfile.parse({ weakSpots: ['动态规划'] }), TODAY);
    assert.ok(basic.resources.length > 0, '断网路径也该给得出资料');
    // 挂到任务上的引用必须是真实存在的
    const pool = new Set(basic.resources.map((r) => r.id));
    for (const t of basic.tasks) {
      for (const id of t.resourceIds) assert.ok(pool.has(id), `${t.id} 引用了池外的 ${id}`);
    }
  });

  it('weeklyMinutes 与可用时段总容量一致（示例文件里出现过 600 配 420 的自相矛盾）', () => {
    for (const { profile } of NASTY) {
      const d = localDraft(profile, TODAY);
      const minutes = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        return h! * 60 + m!;
      };
      const capacity = d.constraints.availableSlots.reduce((s, slot) => s + (minutes(slot.to) - minutes(slot.from)), 0);
      assert.equal(
        d.constraints.weeklyMinutes,
        capacity,
        `${d.constraints.weeklyMinutes} 与时段容量 ${capacity} 对不上`,
      );
    }
  });

  it('每个时段的结束时间都晚于开始时间，且不跨天', () => {
    const d = localDraft(LearnerProfile.parse({ weeklyHours: 20, weekdays: ['mon', 'sat'] }), TODAY);
    for (const s of d.constraints.availableSlots) {
      assert.ok(s.to > s.from, `${s.day} ${s.from}~${s.to} 区间不合法`);
      assert.ok(s.to <= '23:59', `${s.day} 结束时间跨天了：${s.to}`);
    }
  });
});

describe('localDraft：排期遵守学生说过的话', () => {
  const profile = LearnerProfile.parse({
    goalStatement: '把 DP 练出来',
    deadline: '2027-04-11',
    level: 'intermediate',
    weeklyHours: 6,
    weekdays: ['wed', 'sat'],
    weakSpots: ['动态规划'],
    blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }],
  });

  it('只排在学生说方便的那几天', () => {
    const d = localDraft(profile, TODAY);
    const NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    for (const t of d.tasks) {
      if (!t.scheduledFor) continue;
      const wd = NAMES[new Date(Date.parse(`${t.scheduledFor}T12:00:00Z`)).getUTCDay()];
      assert.ok(profile.weekdays.includes(wd as never), `${t.id} 排到了 ${t.scheduledFor}（${wd}），不在可用日里`);
    }
  });

  it('绝不排进学生说的不可用区间', () => {
    const d = localDraft(profile, TODAY);
    for (const t of d.tasks) {
      if (!t.scheduledFor) continue;
      const inside = t.scheduledFor >= '2026-11-02' && t.scheduledFor <= '2026-11-06';
      assert.equal(inside, false, `${t.id} 被排进了期中考试周：${t.scheduledFor}`);
    }
  });

  it('不可用区间原样搬进 constraints，规则层才能强制执行', () => {
    const d = localDraft(profile, TODAY);
    assert.deepEqual(d.constraints.blackouts, profile.blackouts);
  });

  it('前置任务一定排在后置任务之前（不能同一天）', () => {
    const d = localDraft(profile, TODAY);
    const byId = new Map(d.tasks.map((t) => [t.id, t]));
    for (const t of d.tasks) {
      for (const depId of t.dependsOn) {
        const dep = byId.get(depId);
        assert.ok(dep, `${t.id} 引用了不存在的 ${depId}`);
        if (!t.scheduledFor || !dep?.scheduledFor) continue;
        assert.ok(dep.scheduledFor < t.scheduledFor, `${t.id}(${t.scheduledFor}) 排在前置 ${depId}(${dep.scheduledFor}) 之前或同一天`);
      }
    }
  });

  it('不排到过去', () => {
    const d = localDraft(profile, TODAY);
    for (const t of d.tasks) {
      if (t.scheduledFor) assert.ok(t.scheduledFor >= TODAY, `${t.id} 排到了过去：${t.scheduledFor}`);
    }
  });

  it('学习顺序符合认知规律：先读、再练、再自测、最后复习', () => {
    const d = localDraft(LearnerProfile.parse({ weakSpots: ['动态规划'] }), TODAY);
    const types = d.tasks.map((t) => t.type);
    assert.equal(types[0], 'read');
    assert.equal(types.at(-1), 'review');
    assert.ok(types.includes('practice'));
    assert.ok(types.includes('assess'));
  });

  it('每个任务都挂在某个里程碑上，里程碑又都挂在某个能力点上', () => {
    const d = localDraft(profile, TODAY);
    const msIds = new Set(d.milestones.map((m) => m.id));
    const compIds = new Set(d.competences.map((c) => c.id));
    for (const t of d.tasks) {
      assert.ok(t.milestoneId && msIds.has(t.milestoneId), `${t.id} 的里程碑不存在`);
    }
    for (const m of d.milestones) {
      for (const c of m.competenceIds) assert.ok(compIds.has(c), `${m.id} 引用了不存在的能力点 ${c}`);
    }
  });
});

describe('assemblePlan：不合格的草稿要被挡住并给出可读原因', () => {
  const base = () => localDraft(emptyProfile(), TODAY);

  it('重复 id 被拒绝，且错误信息指名道姓', () => {
    const d = base();
    const dup = DraftOutput.parse({
      ...d,
      tasks: [...d.tasks, { ...d.tasks[0]!, title: '另一个任务' }],
    });
    const r = assemblePlan(dup, { id: 'plan_x', now: `${TODAY}T10:00:00+08:00`, title: 'x' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /id 重复/);
  });

  it('悬空的 dependsOn 引用被拒绝', () => {
    const d = base();
    const bad = DraftOutput.parse({
      ...d,
      tasks: d.tasks.map((t, i) => (i === 0 ? { ...t, dependsOn: ['t_nope'] } : t)),
    });
    const r = assemblePlan(bad, { id: 'plan_x', now: `${TODAY}T10:00:00+08:00`, title: 'x' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /未找到前置任务/);
  });

  it('组装出来的计划带 v1 和一条 plan.create 历史', () => {
    const r = assemble(emptyProfile());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.version, 1);
    assert.equal(r.plan.history.length, 1);
    assert.equal(r.plan.history[0]?.cmd, 'plan.create');
    assert.equal(r.plan.reviews.length, 0);
  });
});

describe('学生亲口说过的事实不由模型改写', () => {
  /**
   * 实测事故：学生填的原话是「蓝桥杯省赛，目标是省一」，
   * 模型把它"润色"成「用每周一 1 小时的固定时段冲刺 2026-11-18 的蓝桥杯省赛，
   * 以省一为目标，把 C++ 基础语法……练到能稳定拿分」。
   * 读起来更专业，但复盘页要原样回显的就是那句话。
   *
   * 提示词里已经写了「保留原话」，模型照样改。所以这类不变量必须由代码强制。
   */
  const profile = LearnerProfile.parse({
    goalStatement: '蓝桥杯省赛，目标是省一',
    deadline: '2026-11-18',
    weakSpots: ['动态规划'],
    blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }],
  });

  it('目标保留学生原话，即使模型写了另一段', () => {
    const d = DraftOutput.parse({
      ...localDraft(profile, TODAY),
      goal: { statement: '用每周一 1 小时的固定时段冲刺省赛，练到能稳定拿分', successCriteria: [], deadline: '2027-12-31', priority: 'high' },
    });
    const r = assemblePlan(d, { id: 'plan_x', now: `${TODAY}T10:00:00+08:00`, title: 'x', profile });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.goal.statement, '蓝桥杯省赛，目标是省一');
  });

  it('截止日以学生填的为准，模型改不动', () => {
    const d = DraftOutput.parse({
      ...localDraft(profile, TODAY),
      goal: { statement: 'x', successCriteria: [], deadline: '2027-12-31', priority: 'high' },
    });
    const r = assemblePlan(d, { id: 'plan_x', now: `${TODAY}T10:00:00+08:00`, title: 'x', profile });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.plan.goal.deadline, '2026-11-18');
  });

  it('学生说的不可用区间必须原样保留，模型漏掉也不行', () => {
    const d = DraftOutput.parse({
      ...localDraft(profile, TODAY),
      constraints: { weeklyMinutes: 300, availableSlots: [], maxSessionMinutes: 90, blackouts: [] },
    });
    const r = assemblePlan(d, { id: 'plan_x', now: `${TODAY}T10:00:00+08:00`, title: 'x', profile });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.plan.constraints.blackouts, profile.blackouts);
  });

  it('不传档案时保持草稿原样（这条路径是给测试和 CLI 用的）', () => {
    const d = localDraft(profile, TODAY);
    const r = assemblePlan(d, { id: 'plan_x', now: `${TODAY}T10:00:00+08:00`, title: 'x' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.plan.goal.statement, d.goal.statement);
  });
});

describe('describePlanDraft：说人话，不暴露内部 id', () => {
  it('摘要里不出现 t_01 / m_1 这类标识', () => {
    const r = assemble(LearnerProfile.parse({ weakSpots: ['动态规划', '图论'], deadline: '2027-04-11' }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const s = describePlanDraft(r.plan);
    assert.doesNotMatch(s, /t_\d|m_\d|c_\d/);
    assert.match(s, /个任务/);
  });
});

describe('parseDraftOutput：把模型的 JSON 翻译成可读报错', () => {
  it('合法输入直接通过', () => {
    const d = localDraft(emptyProfile(), TODAY);
    const r = parseDraftOutput(JSON.parse(JSON.stringify(d)));
    assert.equal(r.ok, true);
  });

  it('缺字段时给出字段路径（修复轮要用这些具体报错）', () => {
    const r = parseDraftOutput({ goal: { statement: 'x' } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /草稿结构不合法/);
  });

  it('完全不是对象时不抛异常，只返回失败', () => {
    const r = parseDraftOutput('这不是 JSON');
    assert.equal(r.ok, false);
  });
});

describe('本地计划能真的被引擎接住', () => {
  it('生成的新计划不会一上来就报一堆偏差（第一天就红一片的计划没人会用）', () => {
    const r: ReturnType<typeof assemble> = assemble(
      LearnerProfile.parse({ deadline: '2027-04-11', weeklyHours: 6, weekdays: ['wed', 'sat'], weakSpots: ['动态规划'] }),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const plan: PlanFile = r.plan;
    // 全新计划不该有超期 / 超载这类"历史遗留"偏差
    const issues = validatePlan(plan);
    assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  });
});
