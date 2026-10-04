import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlanFile, SCHEMA_ID } from '../plan/schema.ts';
import type { PlanFile as PlanFileType } from '../plan/schema.ts';
import { reviewPlan } from '../plan/engine.ts';
import type { ReviewReport } from '../plan/engine.ts';
import { buildAdvisorMessages, engineView, isUseful, validateAdvisorOutput } from './advisor.ts';
import type { AdvisorOutput } from './advisor.ts';

const T0 = '2026-10-06T20:00:00+08:00';
const TODAY = '2026-10-19';

function fixture(): PlanFileType {
  return PlanFile.parse({
    schema: SCHEMA_ID,
    id: 'plan_adv',
    version: 1,
    meta: { title: '顾问测试', created: T0, updated: T0 },
    goal: { statement: '拿下蓝桥杯省赛', deadline: '2026-12-31', priority: 'high' },
    constraints: {
      weeklyMinutes: 600,
      availableSlots: [
        { day: 'mon', from: '19:00', to: '21:00' },
        { day: 'wed', from: '19:00', to: '21:00' },
      ],
      maxSessionMinutes: 90,
      blackouts: [],
    },
    competences: [{ id: 'c1', name: '动态规划', target: 0.8, current: 0.2 }],
    milestones: [{ id: 'm1', title: '基础巩固', due: '2026-11-30', competenceIds: ['c1'], status: 'active' }],
    tasks: [
      {
        id: 't_late',
        title: '过期的任务',
        milestoneId: 'm1',
        estimateMin: 60,
        type: 'practice',
        scheduledFor: '2026-10-05',
        notes: '这题我看不懂题解',
      },
      { id: 't_new', title: '没排期的任务', milestoneId: 'm1', dependsOn: ['t_late'], estimateMin: 60, type: 'practice' },
      {
        id: 't_done',
        title: '已完成的任务',
        milestoneId: 'm1',
        estimateMin: 60,
        type: 'read',
        status: 'done',
        actualMin: 60,
        difficulty: 0.3,
        notes: '这条不该出现在上下文里',
      },
    ],
    reviews: [
      { at: T0, plannedTasks: 10, completedTasks: 10, loadFeedback: 0.2, notes: '还行' },
      { at: T0, plannedTasks: 10, completedTasks: 10, loadFeedback: 0.2, notes: '还行' },
    ],
  });
}

const plan = fixture();
const report: ReviewReport = reviewPlan(plan, TODAY);

/** 构造一份「模型正常输出」的样例，测试再逐项破坏它 */
function goodOutput(over: Partial<AdvisorOutput> = {}): AdvisorOutput {
  return {
    narrative: '这周有一个任务拖了两周，我把它挪到了最近三天。',
    reasons: [{ taskId: 't_late', reason: '拖太久会打击信心，先把它做完再往下走。' }],
    cautions: ['你在笔记里说看不懂题解，建议先看讲解视频再自己写一遍。'],
    recommendedOptions: ['deepen'],
    ...over,
  };
}

describe('前置保证：引擎确实产出了可用的调整与选项', () => {
  it('fixture 能产出调整、偏差与协商选项', () => {
    assert.ok(report.adjustments.length >= 2, `实际 ${report.adjustments.length} 条调整`);
    assert.ok(report.drift.some((d) => d.kind === 'overdue'));
    assert.ok(report.goalOptions.some((o) => o.kind === 'deepen'));
  });
});

describe('validateAdvisorOutput：把模型输出裁到引擎范围内', () => {
  it('正常输出被完整保留', () => {
    const v = validateAdvisorOutput(goodOutput(), plan, report);
    assert.equal(v.narrativeSource, 'llm');
    assert.equal(v.dropped.reasons, 0);
    assert.equal(v.dropped.options, 0);

    const late = v.adjustments.find((a) => a.taskId === 't_late')!;
    assert.equal(late.title, '过期的任务');
    assert.equal(late.llmReason, '拖太久会打击信心，先把它做完再往下走。');
    assert.ok(late.engineReason.length > 0, '引擎理由必须始终存在，作为兜底');
    assert.equal(v.recommendedOptions.length, 1);
    assert.equal(v.recommendedOptions[0]!.kind, 'deepen');
  });

  it('幻觉出来的 taskId 被丢弃并计数，而不是让整个复盘失败', () => {
    const v = validateAdvisorOutput(
      goodOutput({
        reasons: [
          { taskId: 't_late', reason: '有效理由' },
          { taskId: 't_不存在', reason: '模型编的任务' },
        ],
      }),
      plan,
      report
    );
    assert.equal(v.dropped.reasons, 1);
    assert.equal(v.adjustments.find((a) => a.taskId === 't_late')!.llmReason, '有效理由');
    assert.ok(!v.adjustments.some((a) => a.taskId === 't_不存在'));
  });

  it('幻觉出来的选项 kind 被丢弃', () => {
    const v = validateAdvisorOutput(
      goodOutput({ recommendedOptions: ['deepen', 'give_up_everything'] }),
      plan,
      report
    );
    assert.equal(v.dropped.options, 1);
    assert.deepEqual(v.recommendedOptions.map((o) => o.kind), ['deepen']);
  });

  it('模型没提到的调整，llmReason 为 null（界面回退到引擎理由）', () => {
    const v = validateAdvisorOutput(goodOutput({ reasons: [] }), plan, report);
    for (const a of v.adjustments) {
      assert.equal(a.llmReason, null);
      assert.ok(a.engineReason.length > 0);
    }
    assert.equal(v.adjustments.length, report.adjustments.length);
  });

  it('同一任务被写多条理由时取第一条', () => {
    const v = validateAdvisorOutput(
      goodOutput({
        reasons: [
          { taskId: 't_late', reason: '第一条' },
          { taskId: 't_late', reason: '第二条' },
        ],
      }),
      plan,
      report
    );
    assert.equal(v.adjustments.find((a) => a.taskId === 't_late')!.llmReason, '第一条');
  });

  it('所有选项都被丢弃时推荐列表为空，而不是报错', () => {
    const v = validateAdvisorOutput(goodOutput({ recommendedOptions: ['x', 'y'] }), plan, report);
    assert.deepEqual(v.recommendedOptions, []);
    assert.equal(v.dropped.options, 2);
  });

  it('cautions 是自由文本，原样保留', () => {
    const v = validateAdvisorOutput(goodOutput({ cautions: ['a', 'b'] }), plan, report);
    assert.deepEqual(v.cautions, ['a', 'b']);
  });
});

describe('engineView：完全不用 LLM 的降级路径', () => {
  it('覆盖引擎的全部调整，且 llmReason 均为 null', () => {
    const v = engineView(plan, report);
    assert.equal(v.narrativeSource, 'engine');
    assert.equal(v.adjustments.length, report.adjustments.length);
    for (const a of v.adjustments) assert.equal(a.llmReason, null);
    assert.deepEqual(v.cautions, []);
  });

  it('综述里带具体数字，而不是空话', () => {
    const v = engineView(plan, report);
    assert.match(v.narrative, /\d/);
    assert.match(v.narrative, /过期|预估|里程碑/);
  });

  it('没有偏差时也给出明确说法', () => {
    const clean = PlanFile.parse({
      ...JSON.parse(JSON.stringify(plan)),
      tasks: [
        { id: 't_ok', title: '正常任务', milestoneId: 'm1', estimateMin: 60, type: 'practice', scheduledFor: TODAY },
      ],
      reviews: [],
    });
    const v = engineView(clean, reviewPlan(clean, TODAY));
    assert.match(v.narrative, /没有发现偏差/);
  });

  it('推荐的协商选项与引擎一致', () => {
    const v = engineView(plan, report);
    assert.deepEqual(
      v.recommendedOptions.map((o) => o.kind),
      report.goalOptions.map((o) => o.kind)
    );
  });
});

describe('buildAdvisorMessages', () => {
  const { system, user } = buildAdvisorMessages(plan, report);

  it('system 里写清了「不得编造」的硬约束', () => {
    assert.match(system, /不得编造/);
    assert.match(system, /只输出 JSON/);
  });

  it('user 里带上每个调整的 taskId，模型才有合法的引用目标', () => {
    for (const a of report.adjustments) {
      const id = a.kind === 'reschedule' || a.kind === 'estimate' || a.kind === 'dropTask' ? a.taskId : null;
      if (id) assert.ok(user.includes(`taskId=${id}`), `缺少 taskId=${id}`);
    }
  });

  it('user 里带上可用的选项 kind', () => {
    for (const o of report.goalOptions) assert.ok(user.includes(`kind=${o.kind}`), `缺少 kind=${o.kind}`);
  });

  it('只带相关任务的补充信息，无关任务不进上下文', () => {
    assert.ok(user.includes('这题我看不懂题解'), '相关任务的笔记应出现');
    assert.ok(!user.includes('这条不该出现在上下文里'), '无关任务的笔记不该出现');
  });

  it('带出 blackout 日期——否则模型判断不了某日期是否在考试周前后', () => {
    // fixture 默认 blackouts 为空，这里显式造一个
    const p = PlanFile.parse({
      ...JSON.parse(JSON.stringify(plan)),
      constraints: {
        weeklyMinutes: 600,
        availableSlots: [{ day: 'mon', from: '19:00', to: '21:00' }],
        maxSessionMinutes: 90,
        blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }],
      },
    });
    const m = buildAdvisorMessages(p, reviewPlan(p, TODAY));
    assert.ok(m.user.includes('2026-11-02'), '应带出 blackout 起始日');
    assert.ok(m.user.includes('期中考试周'), '应带出 blackout 原因');
  });

  it('带出 notBefore 与 pinned——否则模型会提不存在的问题', () => {
    const p = PlanFile.parse({
      ...JSON.parse(JSON.stringify(plan)),
      tasks: [
        { ...JSON.parse(JSON.stringify(plan.tasks[0])), notBefore: '2026-11-09' },
        { ...JSON.parse(JSON.stringify(plan.tasks[1])), pinned: true, scheduledFor: '2026-11-11' },
      ],
    });
    const m = buildAdvisorMessages(p, reviewPlan(p, TODAY));
    assert.ok(m.user.includes('不得早于 2026-11-09'), '应带出 notBefore');
    assert.ok(m.user.includes('锁定'), '应带出 pinned');
  });

  it('带上目标、时间约束与基准日', () => {
    assert.ok(user.includes('拿下蓝桥杯省赛'));
    assert.ok(user.includes('600'));
    assert.ok(user.includes(TODAY));
  });

  it('没有可用时段时也不崩', () => {
    const p = PlanFile.parse({
      ...JSON.parse(JSON.stringify(plan)),
      constraints: { weeklyMinutes: 600, availableSlots: [], maxSessionMinutes: 90, blackouts: [] },
    });
    const m = buildAdvisorMessages(p, reviewPlan(p, TODAY));
    assert.ok(m.user.length > 0);
  });
});

describe('isUseful：判断模型输出是否值得展示', () => {
  it('有调整但模型一条有效理由都没给出时，视为无用', () => {
    assert.equal(isUseful(goodOutput({ reasons: [{ taskId: '假id', reason: 'x' }] }), report), false);
  });

  it('给出了有效理由时可用', () => {
    assert.equal(isUseful(goodOutput(), report), true);
  });

  it('没有调整建议时，综述本身仍有价值', () => {
    const empty: ReviewReport = { ...report, adjustments: [] };
    assert.equal(isUseful(goodOutput({ reasons: [] }), empty), true);
  });
});
