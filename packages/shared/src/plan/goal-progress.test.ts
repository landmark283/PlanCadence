/**
 * 目标卡片的数字从哪来。
 *
 * 这一层要证的是**同一个学生在同一天不会看到两个不同的数**：
 * 「这条线还剩多少小时、来不来得及」会同时出现在目标卡片、今日页提醒、
 * 复盘方向里，所以它必须只算一遍。下面每条断言都是在钉这件事。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, type PlanFile } from './schema.ts';
import { applyCommand } from './commands.ts';
import { detectDrift } from './engine.ts';
import { describeGoal, goalProgress, unassignedTasks } from './goal-progress.ts';

const T0 = '2026-10-05T09:00:00+08:00';
const TODAY = '2026-10-05';

type LineSpec = {
  id: string;
  title: string;
  due?: string | null;
  status?: 'pending' | 'active' | 'done' | 'dropped';
  criteria?: string[];
  competences?: { id: string; name: string; current: number; target: number; evidence?: string[] }[];
  tasks?: {
    id: string;
    title?: string;
    status?: 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
    estimateMin?: number;
    actualMin?: number | null;
    scheduledFor?: string | null;
  }[];
};

/** 造一份带 N 条线的计划 */
function planOf(lines: LineSpec[], opts: { weeklyMinutes?: number; dates?: boolean } = {}): PlanFile {
  let p = emptyPlan('plan_gp', T0, '测试计划');
  if (opts.weeklyMinutes !== undefined) {
    const c = applyCommand(p, { type: 'constraints.update', at: T0, patch: { weeklyMinutes: opts.weeklyMinutes } });
    if (!c.ok) throw new Error(c.error);
    p = c.plan;
  }

  for (const line of lines) {
    const r = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [
        {
          kind: 'addMilestone',
          milestone: {
            id: line.id,
            title: line.title,
            due: line.due ?? null,
            criteria: line.criteria ?? [],
            status: line.status ?? 'active',
            competenceIds: [],
          },
          competences: (line.competences ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            target: c.target,
            current: c.current,
            evidence: c.evidence ?? [],
          })),
          tasks: (line.tasks ?? []).map((t) => ({
            id: t.id,
            title: t.title ?? `任务 ${t.id}`,
            type: 'practice' as const,
            estimateMin: t.estimateMin ?? 60,
            milestoneId: line.id,
            ...(t.scheduledFor !== undefined ? { scheduledFor: t.scheduledFor } : {}),
          })),
          reason: 'r',
        },
      ],
    });
    if (!r.ok) throw new Error(r.error);
    p = r.plan;
  }

  // 任务状态/实际用时/排期得再发一条命令改——addMilestone 只负责建出来
  const patches = lines.flatMap((line) =>
    (line.tasks ?? []).flatMap((t) => {
      const patch: Record<string, unknown> = {};
      if (t.status) patch.status = t.status;
      if (t.actualMin !== undefined) patch.actualMin = t.actualMin;
      if (t.scheduledFor !== undefined) patch.scheduledFor = t.scheduledFor;
      return Object.keys(patch).length ? [{ kind: 'taskPatch' as const, taskId: t.id, patch, reason: 'r' }] : [];
    })
  );
  if (patches.length) {
    const r = applyCommand(p, { type: 'plan.applyAdjustments', at: T0, applied: patches });
    if (!r.ok) throw new Error(r.error);
    p = r.plan;
  }
  return p;
}

describe('每条线各自的进度', () => {
  it('任务和投入分钟按线分开算，不串味', () => {
    const p = planOf([
      {
        id: 'm_a',
        title: '基础算法',
        due: '2026-11-30',
        tasks: [
          { id: 't_a1', estimateMin: 60, status: 'done', actualMin: 90 },
          { id: 't_a2', estimateMin: 45 },
        ],
      },
      {
        id: 'm_b',
        title: '蓝桥杯',
        due: '2026-12-31',
        tasks: [{ id: 't_b1', estimateMin: 120, status: 'done', actualMin: 100 }],
      },
    ]);

    const [a, b] = goalProgress(p, TODAY);
    assert.equal(a?.title, '基础算法');
    assert.equal(a?.totalTasks, 2);
    assert.equal(a?.doneTasks, 1);
    assert.equal(a?.spentMin, 90, '完成的那项按实际用时算');
    assert.equal(a?.remainingMin, 45, '没完成的那项按预估算');

    assert.equal(b?.title, '蓝桥杯');
    assert.equal(b?.totalTasks, 1);
    assert.equal(b?.spentMin, 100);
    assert.equal(b?.remainingMin, 0);
  });

  it('已收尾的线排在后面，还在跑的按截止日从近到远', () => {
    const p = planOf([
      { id: 'm_late', title: '十二月的事', due: '2026-12-31' },
      { id: 'm_done', title: '做完了的', due: '2026-10-01', status: 'done' },
      { id: 'm_soon', title: '十一月底的事', due: '2026-11-30' },
      { id: 'm_dropped', title: '不做了的', status: 'dropped' },
    ]);
    const titles = goalProgress(p, TODAY).map((g) => g.title);
    // 学生打开这一屏问的是「哪条线还在跑、哪条紧」
    assert.deepEqual(titles, ['十一月底的事', '十二月的事', '做完了的', '不做了的']);
  });

  it('没有截止日的线排在带截止日的后面（不是不重要，是没法排序）', () => {
    const p = planOf([
      { id: 'm_none', title: '没定日期的' },
      { id: 'm_due', title: '有日期的', due: '2026-12-31' },
    ]);
    assert.deepEqual(goalProgress(p, TODAY).map((g) => g.title), ['有日期的', '没定日期的']);
    assert.equal(goalProgress(p, TODAY)[1]?.daysLeft, null);
  });

  it('天数：还没到、今天、已经过了，三种说法都不含糊', () => {
    const p = planOf([
      { id: 'm_future', title: '未来', due: '2026-10-15' },
      { id: 'm_today', title: '今天', due: TODAY },
      { id: 'm_past', title: '过期', due: '2026-10-01' },
    ]);
    const by = new Map(goalProgress(p, TODAY).map((g) => [g.title, g]));
    assert.equal(by.get('未来')?.daysLeft, 10);
    assert.equal(by.get('未来')?.overdue, false);
    assert.equal(by.get('今天')?.daysLeft, 0);
    assert.equal(by.get('今天')?.overdue, false, '今天到期还不算过期');
    assert.equal(by.get('过期')?.daysLeft, -4, '过期就是负数，不夹到 0');
    assert.equal(by.get('过期')?.overdue, true);
  });

  it('已经做完的线不报过期（收尾了就不该再催）', () => {
    const p = planOf([
      { id: 'm_done', title: '做完了', due: '2026-10-01', status: 'done', tasks: [{ id: 't_x', status: 'done' }] },
    ]);
    const g = goalProgress(p, TODAY)[0];
    assert.equal(g?.overdue, false);
    assert.equal(g?.daysLeft, -4, '天数照算，只是不标成「要动作」');
  });

  it('排期区间取这条线自己的任务', () => {
    const p = planOf([
      {
        id: 'm_a',
        title: 'A',
        tasks: [
          { id: 't_1', scheduledFor: '2026-10-20' },
          { id: 't_2', scheduledFor: '2026-10-08' },
          { id: 't_3', scheduledFor: null },
        ],
      },
    ]);
    const g = goalProgress(p, TODAY)[0];
    assert.equal(g?.firstScheduled, '2026-10-08');
    assert.equal(g?.lastScheduled, '2026-10-20');
  });

  it('一项都没排期时两个区间都是 null，而不是空字符串', () => {
    const p = planOf([{ id: 'm_a', title: 'A', tasks: [{ id: 't_1', scheduledFor: null }] }]);
    const g = goalProgress(p, TODAY)[0];
    assert.equal(g?.firstScheduled, null);
    assert.equal(g?.lastScheduled, null);
  });

  /**
   * 「排期 10月25日」这句话会骗人：两项任务只排上一项时，它读起来像这条线排好了。
   * 所以悬着的项数要单独给出来——待排池里那几项并不标明自己属于哪条线，
   * 目标卡片是学生唯一能看见它的地方。
   */
  it('还有任务悬在待排池时，要把件数算出来（区间本身看不出来）', () => {
    const p = planOf([
      {
        id: 'm_a',
        title: 'A',
        tasks: [
          { id: 't_1', scheduledFor: '2026-10-25' },
          { id: 't_2', scheduledFor: null },
          { id: 't_3', scheduledFor: null, status: 'done' },
        ],
      },
    ]);
    const g = goalProgress(p, TODAY)[0];
    assert.equal(g?.firstScheduled, '2026-10-25');
    assert.equal(g?.lastScheduled, '2026-10-25');
    // 已完成的那项不算「悬着」
    assert.equal(g?.unscheduledTasks, 1);
  });

  it('全部排好时悬着的件数是 0', () => {
    const p = planOf([
      {
        id: 'm_a',
        title: 'A',
        tasks: [
          { id: 't_1', scheduledFor: '2026-10-25' },
          { id: 't_2', scheduledFor: '2026-10-26' },
        ],
      },
    ]);
    assert.equal(goalProgress(p, TODAY)[0]?.unscheduledTasks, 0);
  });

  it('能力点带证据标记：没有证据时界面不该显示一个像成绩的百分数', () => {
    const p = planOf([
      {
        id: 'm_a',
        title: 'A',
        competences: [
          { id: 'c_1', name: '动态规划', current: 0.45, target: 0.8, evidence: ['t_1'] },
          { id: 'c_2', name: '图论', current: 0, target: 0.7 },
        ],
      },
    ]);
    const g = goalProgress(p, TODAY)[0];
    assert.equal(g?.competences.length, 2);
    assert.equal(g?.competences[0]?.hasEvidence, true);
    assert.equal(g?.competences[1]?.hasEvidence, false);
    assert.equal(g?.competences[1]?.current, 0);
  });

  it('引用了不存在的能力点就跳过，不画一个空名字', () => {
    let p = planOf([{ id: 'm_a', title: 'A' }]);
    const r = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [{ kind: 'milestone', milestoneId: 'm_a', patch: { criteria: ['x'] }, reason: 'r' }],
    });
    if (!r.ok) throw new Error(r.error);
    p = r.plan;
    // 手改文件可能留下悬空引用；这一层不该抛
    const broken = { ...p, milestones: p.milestones.map((m) => ({ ...m, competenceIds: ['c_不存在'] })) };
    assert.deepEqual(goalProgress(broken, TODAY)[0]?.competences, []);
  });

  it('风险来自引擎的偏差，不由界面自己猜', () => {
    const p = planOf([
      {
        id: 'm_tight',
        title: '很紧的线',
        due: '2026-10-07',
        tasks: [{ id: 't_1', estimateMin: 600, scheduledFor: '2026-10-06' }],
      },
    ]);
    const withDrift = goalProgress(p, TODAY, detectDrift(p, TODAY));
    assert.equal(withDrift[0]?.atRisk, true, '引擎报了风险，卡片上就要标出来');
    assert.ok((withDrift[0]?.shortfallMin ?? 0) > 0);

    // 不传偏差时不假装知道——这一层只如实转达引擎说过的话
    const withoutDrift = goalProgress(p, TODAY);
    assert.equal(withoutDrift[0]?.atRisk, false);
    assert.equal(withoutDrift[0]?.shortfallMin, null);
  });
});

describe('不属于任何一条线的任务', () => {
  it('没有 milestoneId 的任务要能找出来（目标屏得提一句）', () => {
    const p = planOf([{ id: 'm_a', title: 'A', tasks: [{ id: 't_1' }] }]);
    const r = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [
        {
          kind: 'addTask',
          task: { id: 't_free', title: '顺手加的一项', type: 'read', estimateMin: 30, milestoneId: null },
          reason: 'r',
        },
      ],
    });
    if (!r.ok) throw new Error(r.error);

    const free = unassignedTasks(r.plan);
    assert.deepEqual(free.map((t) => t.id), ['t_free']);
    // 而它不在任何一条线的计数里 —— 这正是界面必须提一句的原因
    assert.equal(goalProgress(r.plan, TODAY).reduce((s, g) => s + g.totalTasks, 0), 1);
  });

  it('指向已删除目标的悬空引用也算「不属于任何一条线」', () => {
    const p = planOf([{ id: 'm_a', title: 'A', tasks: [{ id: 't_1' }] }]);
    const dangling = { ...p, tasks: p.tasks.map((t) => ({ ...t, milestoneId: 'm_没了' })) };
    assert.deepEqual(unassignedTasks(dangling).map((t) => t.id), ['t_1']);
  });
});

describe('一句话进度：三处说法一致', () => {
  it('正常情况把项数、剩余小时、剩余天数都说出来', () => {
    const p = planOf([
      {
        id: 'm_a',
        title: 'A',
        due: '2026-10-15',
        tasks: [
          { id: 't_1', estimateMin: 60, status: 'done', actualMin: 60 },
          { id: 't_2', estimateMin: 180, scheduledFor: '2026-10-10' },
        ],
      },
    ]);
    const text = describeGoal(goalProgress(p, TODAY)[0]!);
    assert.match(text, /1\/2 项/);
    assert.match(text, /还剩约 3 小时/);
    assert.match(text, /还剩 10 天/);
  });

  it('过期时说「已过期 N 天」，不说「还剩 -4 天」', () => {
    const p = planOf([{ id: 'm_a', title: 'A', due: '2026-10-01', tasks: [{ id: 't_1' }] }]);
    const text = describeGoal(goalProgress(p, TODAY)[0]!);
    assert.match(text, /已过期 4 天/);
    assert.equal(text.includes('-4'), false);
  });

  it('今天截止是单独一句话（「还剩 0 天」读起来像没有信息）', () => {
    const p = planOf([{ id: 'm_a', title: 'A', due: TODAY, tasks: [{ id: 't_1' }] }]);
    assert.match(describeGoal(goalProgress(p, TODAY)[0]!), /今天截止/);
  });

  it('没有任何数字时也不吐出空字符串里的引号', () => {
    const p = planOf([{ id: 'm_a', title: 'A', criteria: ['光有判据'] }]);
    const g = goalProgress(p, TODAY)[0]!;
    assert.equal(g.totalTasks, 0);
    assert.equal(describeGoal(g), '', '这条线还没有任务，界面该显示的是「还没有具体任务」而不是一串空话');
  });
});
