/**
 * 自适应引擎的自证测试。
 *
 * 与 plan.test.ts 同样的理由：这层是纯函数，AI 必须能自己判断对错，
 * 人类不需要读 engine.ts 的实现，只需要看这里是否全绿。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlanFile, SCHEMA_ID, validatePlan } from './schema.ts';
import type { TaskInput } from './schema.ts';
import { applyCommand } from './commands.ts';
import {
  availableMinutes,
  detectDrift,
  masteryGain,
  nextMastery,
  proposeGoalOptions,
  proposeMasteryUpdates,
  proposeReschedule,
  reviewPlan,
} from './engine.ts';

const T0 = '2026-10-06T20:00:00+08:00';
/** 2026-10-19 是周一 */
const TODAY = '2026-10-19';

const SLOTS = [
  { day: 'mon' as const, from: '19:00', to: '21:00' }, // 120 min
  { day: 'wed' as const, from: '19:00', to: '21:00' }, // 120 min
  { day: 'sat' as const, from: '09:00', to: '12:00' }, // 180 min
];

function fixture(over: Partial<Record<string, unknown>> = {}): PlanFile {
  return PlanFile.parse({
    schema: SCHEMA_ID,
    id: 'plan_eng',
    version: 1,
    meta: { title: '引擎测试', created: T0, updated: T0 },
    goal: { statement: '测出引擎的问题', deadline: '2026-12-31', priority: 'high' },
    constraints: { weeklyMinutes: 600, availableSlots: SLOTS, maxSessionMinutes: 90, blackouts: [] },
    competences: [{ id: 'c_dp', name: '动态规划', target: 0.8, current: 0.2 }],
    milestones: [{ id: 'm1', title: '基础巩固', due: '2026-11-30', competenceIds: ['c_dp'], status: 'active' }],
    tasks: [],
    ...over,
  });
}

const T = (id: string, over: Partial<TaskInput> = {}): TaskInput => ({
  id,
  title: `任务 ${id}`,
  estimateMin: 60,
  type: 'practice',
  milestoneId: 'm1',
  ...over,
});

/* ------------------------------------------------------------------ */

describe('availableMinutes', () => {
  it('按 availableSlots 展开并受周预算封顶', () => {
    // 2026-10-19(一)~10-25(日)：120 + 120 + 180 = 420，未触及周预算 600
    assert.equal(availableMinutes(fixture(), '2026-10-19', '2026-10-25'), 420);
  });

  it('blackout 区间内不计入可用时长', () => {
    const p = fixture({
      constraints: {
        weeklyMinutes: 600,
        availableSlots: SLOTS,
        maxSessionMinutes: 90,
        blackouts: [{ from: '2026-10-19', to: '2026-10-25' }],
      },
    });
    assert.equal(availableMinutes(p, '2026-10-19', '2026-10-25'), 0);
  });

  it('起止倒置返回 0', () => {
    assert.equal(availableMinutes(fixture(), '2026-10-25', '2026-10-19'), 0);
  });
});

describe('detectDrift', () => {
  it('识别过期任务并算出天数', () => {
    const p = fixture({ tasks: [T('t1', { scheduledFor: '2026-10-10' })] });
    const overdue = detectDrift(p, TODAY).filter((d) => d.kind === 'overdue');
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]!.kind === 'overdue' && overdue[0]!.days, 9);
  });

  it('区分预估偏低(overrun)与预估偏高(underrun)', () => {
    const p = fixture({
      tasks: [
        T('t_fast', { status: 'done', estimateMin: 100, actualMin: 30 }),
        T('t_slow', { status: 'done', estimateMin: 100, actualMin: 200 }),
        T('t_ok', { status: 'done', estimateMin: 100, actualMin: 100 }),
      ],
    });
    const kinds = detectDrift(p, TODAY).map((d) => `${d.kind}:${'taskId' in d ? d.taskId : ''}`);
    assert.ok(kinds.includes('underrun:t_fast'), kinds.join(','));
    assert.ok(kinds.includes('overrun:t_slow'), kinds.join(','));
    assert.ok(!kinds.some((k) => k.endsWith('t_ok')), kinds.join(','));
  });

  it('识别卡住的进行中任务', () => {
    const p = fixture({ tasks: [T('t_stuck', { status: 'doing', scheduledFor: '2026-10-10' })] });
    assert.equal(detectDrift(p, TODAY).filter((d) => d.kind === 'stalled').length, 1);
  });

  it('识别被过期前置任务卡住的链', () => {
    const p = fixture({
      tasks: [
        T('t_a', { scheduledFor: '2026-10-01' }),
        T('t_b', { dependsOn: ['t_a'], scheduledFor: '2026-10-15' }),
      ],
    });
    const blocked = detectDrift(p, TODAY).filter((d) => d.kind === 'chainBlocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.kind === 'chainBlocked' && blocked[0]!.blockedBy, 't_a');
  });

  it('识别周预算超载', () => {
    const p = fixture({
      tasks: [
        T('t1', { estimateMin: 300, scheduledFor: '2026-10-19' }),
        T('t2', { estimateMin: 300, scheduledFor: '2026-10-20' }),
        T('t3', { estimateMin: 300, scheduledFor: '2026-10-21' }),
      ],
    });
    const over = detectDrift(p, TODAY).filter((d) => d.kind === 'budgetOver');
    assert.equal(over.length, 1);
    assert.equal(over[0]!.kind === 'budgetOver' && over[0]!.plannedMin, 900);
  });

  it('识别里程碑风险并算出缺口', () => {
    const p = fixture({
      milestones: [
        { id: 'm1', title: '基础巩固', due: '2026-10-25', competenceIds: ['c_dp'], status: 'active' },
      ],
      tasks: [T('t_big', { estimateMin: 1000 })],
    });
    const risk = detectDrift(p, TODAY).filter((d) => d.kind === 'milestoneRisk');
    assert.equal(risk.length, 1);
    // 可用 420 分钟，缺口 580
    assert.equal(risk[0]!.kind === 'milestoneRisk' && risk[0]!.shortfallMin, 580);
  });
});

describe('proposeReschedule', () => {
  it('无活跃任务时不产生任何建议', () => {
    const p = fixture({ tasks: [T('t1', { status: 'done', actualMin: 60 })] });
    assert.deepEqual(proposeReschedule(p, TODAY), []);
  });

  it('前置任务一定排在后置任务之前', () => {
    const p = fixture({
      tasks: [T('t_b', { dependsOn: ['t_a'] }), T('t_a')],
    });
    const adj = proposeReschedule(p, TODAY);
    const at = (id: string) => {
      const a = adj.find((x) => x.kind === 'reschedule' && x.taskId === id);
      return a && a.kind === 'reschedule' ? a.scheduledFor : null;
    };
    const da = at('t_a');
    const db = at('t_b');
    assert.ok(da, '前置任务未被排期');
    assert.ok(db, '后置任务未被排期');
    assert.ok(db! > da!, `后置 ${db} 应晚于前置 ${da}`);
  });

  it('单次调整幅度受 30% 护栏限制', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      T(`t${i}`, { scheduledFor: '2026-10-01' }) // 全部过期，都想动
    );
    const adj = proposeReschedule(fixture({ tasks }), TODAY);
    assert.ok(adj.length <= Math.ceil(10 * 0.3), `实际 ${adj.length} 条，超过 30% 护栏`);
    assert.ok(adj.length >= 1);
  });

  it('不会把任务排进 blackout 区间', () => {
    const p = fixture({
      constraints: {
        weeklyMinutes: 600,
        availableSlots: SLOTS,
        maxSessionMinutes: 90,
        blackouts: [{ from: '2026-10-19', to: '2026-10-25' }],
      },
      tasks: [T('t1')],
    });
    const adj = proposeReschedule(p, TODAY);
    for (const a of adj) {
      if (a.kind !== 'reschedule' || !a.scheduledFor) continue;
      assert.ok(a.scheduledFor < '2026-10-19' || a.scheduledFor > '2026-10-25', `排进了 blackout：${a.scheduledFor}`);
    }
  });

  it('未配置可用时段时退化为按周排期，而不是清空所有排期', () => {
    const p = fixture({
      constraints: { weeklyMinutes: 600, availableSlots: [], maxSessionMinutes: 90, blackouts: [] },
      tasks: [T('t1')],
    });
    const adj = proposeReschedule(p, TODAY);
    assert.equal(adj.length, 1);
    assert.ok(adj[0]!.kind === 'reschedule' && adj[0]!.scheduledFor !== null);
  });

  it('每条建议都带非空理由（协商页要逐条展示）', () => {
    const p = fixture({ tasks: [T('t1', { scheduledFor: '2026-10-01' })] });
    for (const a of proposeReschedule(p, TODAY)) {
      assert.ok(typeof a.reason === 'string' && a.reason.length > 0);
    }
  });
});

describe('掌握度', () => {
  it('边际递减：越接近掌握，同样努力涨得越少', () => {
    const low = nextMastery(0.1, 0.15) - 0.1;
    const high = nextMastery(0.9, 0.15) - 0.9;
    assert.ok(low > high, `低掌握增量 ${low} 应大于高掌握增量 ${high}`);
  });

  it('结果始终落在 [0,1]', () => {
    assert.equal(nextMastery(0.99, 10), 1);
    assert.equal(nextMastery(0, 0), 0);
    assert.ok(nextMastery(0.5, 0.15) > 0 && nextMastery(0.5, 0.15) < 1);
  });

  it('难度越高，单次掌握度增量越小', () => {
    const easy = masteryGain({ difficulty: 0.1, actualMin: 60, estimateMin: 60, type: 'practice' } as never);
    const hard = masteryGain({ difficulty: 0.9, actualMin: 60, estimateMin: 60, type: 'practice' } as never);
    assert.ok(easy > hard);
  });

  it('已经计入证据的任务不重复累加', () => {
    const done = T('t1', { status: 'done', actualMin: 60, difficulty: 0.2 });
    const fresh = fixture({ tasks: [done] });
    assert.equal(proposeMasteryUpdates(fresh).length, 1);

    const already = fixture({
      tasks: [done],
      competences: [{ id: 'c_dp', name: '动态规划', target: 0.8, current: 0.2, evidence: ['t1'] }],
    });
    assert.deepEqual(proposeMasteryUpdates(already), []);
  });

  it('掌握度只增不减，且证据被记录', () => {
    const p = fixture({
      tasks: [
        T('t1', { status: 'done', actualMin: 60, difficulty: 0.2, scheduledFor: '2026-10-07' }),
        T('t2', { status: 'done', actualMin: 60, difficulty: 0.3, scheduledFor: '2026-10-08' }),
      ],
    });
    const ups = proposeMasteryUpdates(p);
    assert.equal(ups.length, 2);
    assert.ok(ups[0]!.to > ups[0]!.from);
    assert.ok(ups[1]!.to > ups[0]!.to);
    assert.deepEqual(
      ups.map((u) => u.evidenceTaskId),
      ['t1', 't2']
    );
  });

  it('复习型任务只巩固，不新增能力证据', () => {
    const p = fixture({ tasks: [T('t_rev', { status: 'done', actualMin: 30, difficulty: 0.1, type: 'review' })] });
    assert.deepEqual(proposeMasteryUpdates(p), []);
  });
});

describe('proposeGoalOptions', () => {
  const review = (plannedTasks: number, completedTasks: number, loadFeedback: number) => ({
    at: T0,
    plannedTasks,
    completedTasks,
    loadFeedback,
    notes: '',
    adjustments: [],
  });

  it('连续两期又快又轻松时，提供加深/加速/转向竞赛三个选项', () => {
    const p = fixture({ reviews: [review(10, 10, 0.2), review(10, 9, 0.3)] });
    const kinds = proposeGoalOptions(p, []).map((o) => o.kind);
    assert.ok(kinds.includes('deepen'), kinds.join(','));
    assert.ok(kinds.includes('accelerate'), kinds.join(','));
    assert.ok(kinds.includes('contest'), kinds.join(','));
  });

  it('连续两期吃力的时，提供延长/缩范围/降周目标三个选项', () => {
    const p = fixture({ reviews: [review(10, 3, 0.8), review(10, 4, 0.85)] });
    const kinds = proposeGoalOptions(p, []).map((o) => o.kind);
    assert.ok(kinds.includes('extendDeadline'), kinds.join(','));
    assert.ok(kinds.includes('narrowScope'), kinds.join(','));
    assert.ok(kinds.includes('lowerWeekly'), kinds.join(','));
  });

  it('里程碑有风险时提议拆分，且理由里带具体数字', () => {
    const p = fixture({
      milestones: [{ id: 'm1', title: '基础巩固', due: '2026-10-25', competenceIds: ['c_dp'], status: 'active' }],
      tasks: [T('t_big', { estimateMin: 1000 })],
    });
    const drift = detectDrift(p, TODAY);
    const opts = proposeGoalOptions(p, drift);
    const split = opts.find((o) => o.kind === 'splitMilestone');
    assert.ok(split, '应提议拆分里程碑');
    assert.match(split!.rationale, /\d/);
  });

  it('只有一期复盘时不轻易给建议（避免过早下判断）', () => {
    const p = fixture({ reviews: [review(10, 10, 0.1)] });
    assert.deepEqual(proposeGoalOptions(p, []), []);
  });

  it('每个选项都必须给出影响与后果，不能只有标题', () => {
    const p = fixture({ reviews: [review(10, 10, 0.2), review(10, 10, 0.2)] });
    for (const o of proposeGoalOptions(p, [])) {
      assert.ok(o.rationale.length > 0, `${o.kind} 缺 rationale`);
      assert.ok(o.impact.length > 0, `${o.kind} 缺 impact`);
      assert.ok(o.consequences.length > 0, `${o.kind} 缺 consequences`);
    }
  });
});

describe('reviewPlan 聚合', () => {
  it('一次调用给出复盘页需要的全部数据', () => {
    const p = fixture({
      tasks: [T('t1', { scheduledFor: '2026-10-01' }), T('t2')],
      reviews: [
        { at: T0, plannedTasks: 10, completedTasks: 10, loadFeedback: 0.2, notes: '', adjustments: [] },
        { at: T0, plannedTasks: 10, completedTasks: 10, loadFeedback: 0.2, notes: '', adjustments: [] },
      ],
    });
    const r = reviewPlan(p, TODAY);
    assert.ok(r.drift.length > 0);
    assert.ok(r.adjustments.length > 0);
    assert.ok(r.goalOptions.length > 0);
    assert.equal(r.today, TODAY);
  });
});

describe('锁定（pinned）—— 尊重学生的主动决策', () => {
  it('锁定的任务不会被自动重排', () => {
    const p = fixture({
      tasks: [T('t_locked', { scheduledFor: '2026-12-01', pinned: true }), T('t_free')],
    });
    const adj = proposeReschedule(p, TODAY);
    assert.ok(
      !adj.some((a) => a.kind === 'reschedule' && a.taskId === 't_locked'),
      '锁定任务不该出现在建议里'
    );
  });

  it('锁定任务占用的时间会被预留，可动任务不会挤进去', () => {
    // 2026-10-19（周一）只有 120 分钟，被锁定任务占满后，可动任务必须排到别的日子
    const p = fixture({
      tasks: [
        T('t_locked', { scheduledFor: '2026-10-19', estimateMin: 120, pinned: true }),
        T('t_free', { estimateMin: 120 }),
      ],
    });
    const free = proposeReschedule(p, TODAY).find((a) => a.kind === 'reschedule' && a.taskId === 't_free');
    assert.ok(free && free.kind === 'reschedule', '可动任务应被排期');
    assert.notEqual(free.scheduledFor, '2026-10-19');
  });

  it('全部锁定时不产生任何建议', () => {
    const p = fixture({ tasks: [T('t_locked', { scheduledFor: '2026-12-01', pinned: true })] });
    assert.deepEqual(proposeReschedule(p, TODAY), []);
  });
});

describe('notBefore：学生明说的「最早可安排日」', () => {
  it('不会被排到 notBefore 之前', () => {
    const p = fixture({ tasks: [T('t_wait', { notBefore: '2026-11-09' })] });
    const a = proposeReschedule(p, TODAY).find((x) => x.kind === 'reschedule' && x.taskId === 't_wait');
    assert.ok(a && a.kind === 'reschedule', '应被排期');
    assert.ok(a.scheduledFor && a.scheduledFor >= '2026-11-09', `实际排到 ${a.scheduledFor}`);
  });

  it('对照组：没有 notBefore 时同一任务会被排到最近的可用时点', () => {
    const a = proposeReschedule(fixture({ tasks: [T('t_free')] }), TODAY)[0]!;
    assert.ok(a.kind === 'reschedule');
    assert.equal(a.scheduledFor, '2026-10-19');
  });

  it('notBefore 落在可见范围之外时不硬塞——保持待排，不产生无意义的调整', () => {
    const p = fixture({ tasks: [T('t_far', { notBefore: '2030-01-01' })] });
    assert.deepEqual(proposeReschedule(p, TODAY), []);
  });

  it('把引擎的排期真正写回后，不会再报「早于最早可安排日」', () => {
    const p = fixture({ tasks: [T('t_wait', { notBefore: '2026-11-09' })] });
    const applied = applyCommand(p, { type: 'plan.applyAdjustments', at: T0, applied: proposeReschedule(p, TODAY) });
    assert.equal(applied.ok, true, applied.ok ? '' : applied.error);
    if (applied.ok) {
      assert.deepEqual(
        validatePlan(applied.plan).filter((i) => i.message.includes('最早可安排日')),
        []
      );
    }
  });

  it('锁定与 notBefore 可以同时用：日期固定且不早于下限', () => {
    const p = fixture({ tasks: [T('t_both', { scheduledFor: '2026-11-11', pinned: true, notBefore: '2026-11-09' })] });
    assert.deepEqual(proposeReschedule(p, TODAY), [], '锁定任务不该出现在建议里');
  });
});

describe('调整理由必须具体（协商页的唯一依据）', () => {
  it('首次排期不能被描述成「重排」', () => {
    const a = proposeReschedule(fixture({ tasks: [T('t_new')] }), TODAY)[0]!;
    assert.match(a.reason, /纳入排期/);
    assert.ok(!a.reason.includes('顺延') && !a.reason.includes('提前'), a.reason);
  });

  it('改期说明从哪天到哪天，以及依据', () => {
    const a = proposeReschedule(fixture({ tasks: [T('t_moved', { scheduledFor: '2026-10-26' })] }), TODAY)[0]!;
    assert.match(a.reason, /从 2026-10-26 提前到/);
    assert.match(a.reason, /重新填充|已过期/);
  });

  it('过期任务的理由里带过期天数', () => {
    const a = proposeReschedule(fixture({ tasks: [T('t_late', { scheduledFor: '2026-10-05' })] }), TODAY)[0]!;
    assert.match(a.reason, /已过期 14 天/);
  });
});
