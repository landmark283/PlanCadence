/**
 * 提案（Proposal）的测试。
 *
 * 这一层是「模型提议、代码把关」的把关处，所以测试要盯的是**拒绝**：
 * 编出来的 id、过去的日期、撞上不可用区间的日期、越界的时长——每一条都得被拦住，
 * 而且拦下来的理由要是**人话**（它会原样显示给学生）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, Goal, Task, type PlanFile } from './schema.ts';
import { applyCommand } from './commands.ts';
import { LearnerProfile } from '../llm/interview.ts';
import {
  GoalPatch,
  ProfilePatch,
  Proposal,
  TaskPatchSchema,
  proposalKey,
  proposalTaskId,
  toAppliedAdjustment,
  validateProposal,
} from './proposal.ts';
import { describeProposal } from './describe.ts';

const T0 = '2026-10-05T09:00:00+08:00';
const TODAY = '2026-10-05';

function planWith(
  tasks: { id: string; title?: string; scheduledFor?: string | null; estimateMin?: number; notBefore?: string | null }[],
  blackouts: { from: string; to: string; reason?: string }[] = [],
): PlanFile {
  let p = emptyPlan('plan_prop', T0, '测试计划');
  for (const t of tasks) {
    const r = applyCommand(p, {
      type: 'task.add',
      at: T0,
      task: {
        id: t.id,
        title: t.title ?? `任务 ${t.id}`,
        estimateMin: t.estimateMin ?? 45,
        type: 'read',
        scheduledFor: t.scheduledFor ?? null,
        notBefore: t.notBefore ?? null,
      },
    });
    if (!r.ok) throw new Error(r.error);
    p = r.plan;
  }
  if (blackouts.length) {
    const r = applyCommand(p, { type: 'constraints.update', at: T0, patch: { blackouts } });
    if (!r.ok) throw new Error(r.error);
    p = r.plan;
  }
  return p;
}

const move = (taskId: string, scheduledFor: string | null) => ({
  kind: 'reschedule' as const,
  taskId,
  scheduledFor,
  reason: '换个日子',
  engineReason: '换个日子',
});

describe('白名单：允许改哪些字段，是显式写下来的', () => {
  it('GoalPatch 的键是 Goal 的子集', () => {
    for (const k of Object.keys(GoalPatch.shape)) {
      assert.ok(k in Goal.shape, `GoalPatch 里的 ${k} 在 Goal 里不存在`);
    }
  });

  it('ProfilePatch 的键是 LearnerProfile 的子集', () => {
    for (const k of Object.keys(ProfilePatch.shape)) {
      assert.ok(k in LearnerProfile.shape, `ProfilePatch 里的 ${k} 在 LearnerProfile 里不存在`);
    }
  });

  it('多给的字段被丢掉，而不是让整条提案失败', () => {
    const parsed = Proposal.safeParse({
      kind: 'goal',
      patch: { statement: '新目标', 乱入的字段: 'x' },
      reason: 'r',
      engineReason: 'r',
    });
    assert.equal(parsed.success, true);
    if (!parsed.success || parsed.data.kind !== 'goal') return;
    assert.deepEqual(Object.keys(parsed.data.patch), ['statement']);
  });

  it('Proposal 覆盖了 AppliedAdjustment 的每一种', () => {
    // 两套形状漂移的后果是「AI 能改但我改不了」，所以这条要有测试盯着
    const appliedKinds = ['reschedule', 'estimate', 'goal', 'addTask', 'dropTask', 'addResource'];
    const proposalKinds: string[] = Proposal.options.map((o) => o.shape.kind.value);
    for (const k of appliedKinds) {
      assert.ok(proposalKinds.includes(k), `Proposal 里缺少 ${k}`);
    }
  });
});

describe('proposalKey：稳定，且同一任务的不同提案不撞', () => {
  it('改期和调时长是两条，key 不同', () => {
    const a = proposalKey(move('t_a', '2026-10-07'));
    const b = proposalKey({
      kind: 'estimate',
      taskId: 't_a',
      estimateMin: 90,
      reason: 'r',
      engineReason: 'r',
    });
    assert.notEqual(a, b);
  });

  it('和数组下标无关：它只由内容决定', () => {
    assert.equal(proposalKey(move('t_a', '2026-10-07')), proposalKey(move('t_a', '2026-10-07')));
  });

  it('新任务用标题做键（它还没有 id）', () => {
    const k = proposalKey({
      kind: 'addTask',
      task: { title: '加练：X', type: 'practice', estimateMin: 45, notes: '', scheduledFor: null, notBefore: null, tags: [] },
      reason: 'r',
      engineReason: 'r',
    });
    assert.equal(k, 'addTask:加练：X');
  });

  it('proposalTaskId 只对引用任务的提案给 id', () => {
    assert.equal(proposalTaskId(move('t_a', null)), 't_a');
    assert.equal(proposalTaskId({ kind: 'goal', patch: { priority: 'low' }, reason: 'r', engineReason: 'r' }), null);
  });
});

describe('validateProposal：把模型编的东西挡住', () => {
  const plan = planWith(
    [
      { id: 't_a', title: '通读 DP', scheduledFor: '2026-10-07' },
      { id: 't_locked', title: '等考完再说', notBefore: '2026-11-09' },
    ],
    [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }]
  );

  it('计划里没有这一项 → 拒绝', () => {
    const r = validateProposal(move('t_不存在', '2026-10-07'), plan, TODAY);
    assert.equal(r.ok, false);
  });

  it('排到已经过去的日子 → 拒绝', () => {
    const r = validateProposal(move('t_a', '2026-10-01'), plan, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /过去/);
  });

  it('落在学生说的不可用区间里 → 拒绝，而且理由里带上「期中考试周」', () => {
    const r = validateProposal(move('t_a', '2026-11-03'), plan, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /期中考试周/);
  });

  it('早于学生设过的「最早可安排日」→ 拒绝', () => {
    const r = validateProposal(move('t_locked', '2026-10-20'), plan, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /最早/);
  });

  it('移回待排池永远合法（不受日期限制）', () => {
    assert.equal(validateProposal(move('t_locked', null), plan, TODAY).ok, true);
  });

  it('时长越界 → 拒绝', () => {
    const tooBig = validateProposal(
      { kind: 'estimate', taskId: 't_a', estimateMin: 99999, reason: 'r', engineReason: 'r' },
      plan,
      TODAY
    );
    assert.equal(tooBig.ok, false);
    const tooSmall = validateProposal(
      { kind: 'estimate', taskId: 't_a', estimateMin: 1, reason: 'r', engineReason: 'r' },
      plan,
      TODAY
    );
    assert.equal(tooSmall.ok, false);
  });

  it('空 patch 的提案 → 拒绝（它没说要改什么）', () => {
    assert.equal(validateProposal({ kind: 'goal', patch: {}, reason: 'r', engineReason: 'r' }, plan, TODAY).ok, false);
    assert.equal(validateProposal({ kind: 'profile', patch: {}, reason: 'r', engineReason: 'r' }, plan, TODAY).ok, false);
  });

  it('目标的截止日不能是过去', () => {
    const r = validateProposal(
      { kind: 'goal', patch: { deadline: '2020-01-01' }, reason: 'r', engineReason: 'r' },
      plan,
      TODAY
    );
    assert.equal(r.ok, false);
  });

  it('合法的一条通过', () => {
    assert.equal(validateProposal(move('t_a', '2026-10-08'), plan, TODAY).ok, true);
  });
});

describe('落地：提案 → 命令载荷', () => {
  it('addTask 必须有 id，没有就抛（而不是悄悄生成一个）', () => {
    const p = {
      kind: 'addTask' as const,
      task: { title: '加练：X', type: 'practice' as const, estimateMin: 45, notes: '', scheduledFor: null, notBefore: null, tags: [] },
      reason: 'r',
      engineReason: 'r',
    };
    assert.throws(() => toAppliedAdjustment(p), /必须给一个 id/);
    const a = toAppliedAdjustment(p, 't_09');
    assert.equal(a.kind === 'addTask' ? a.task.id : '', 't_09');
  });

  it('profile 也走同一条命令（档案就在计划文件里，这样一次应用才是原子的）', () => {
    const a = toAppliedAdjustment({ kind: 'profile', patch: { weeklyHours: 3 }, reason: 'r', engineReason: 'r' });
    assert.equal(a.kind, 'profile');
    assert.deepEqual(a.kind === 'profile' ? a.patch : null, { weeklyHours: 3 });
  });
});

describe('学生改过的卡：一次改好几个字段', () => {
  const plan = planWith([{ id: 't_a', title: '通读 DP', scheduledFor: '2026-10-07', estimateMin: 45 }]);

  it('TaskPatchSchema 的键是任务 schema 的子集', () => {
    const taskKeys = new Set(Object.keys(Task.shape));
    for (const k of Object.keys(TaskPatchSchema.shape)) {
      assert.ok(taskKeys.has(k), `TaskPatchSchema 里的 ${k} 在 Task 里不存在`);
    }
  });

  it('空补丁 → 拒绝（它没说要改什么）', () => {
    const r = validateProposal({ kind: 'task', taskId: 't_a', patch: {}, reason: 'r', engineReason: 'r' }, plan, TODAY);
    assert.equal(r.ok, false);
  });

  it('时长越界 → 拒绝', () => {
    const r = validateProposal(
      { kind: 'task', taskId: 't_a', patch: { estimateMin: 99999 }, reason: 'r', engineReason: 'r' },
      plan,
      TODAY
    );
    assert.equal(r.ok, false);
  });

  it('日期用和「改期」同一套判断：排到过去 → 拒绝', () => {
    const r = validateProposal(
      { kind: 'task', taskId: 't_a', patch: { scheduledFor: '2026-10-01' }, reason: 'r', engineReason: 'r' },
      plan,
      TODAY
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /过去/);
  });

  it('合法的一条通过，并落成 taskPatch 命令载荷', () => {
    const p = {
      kind: 'task' as const,
      taskId: 't_a',
      patch: { scheduledFor: '2026-10-09', estimateMin: 90 },
      reason: '你自己改的',
      engineReason: '你自己改的',
    };
    assert.equal(validateProposal(p, plan, TODAY).ok, true);
    const a = toAppliedAdjustment(p);
    assert.equal(a.kind, 'taskPatch');
  });

  it('卡片上只说真的变了的那些字段', () => {
    const r = describeProposal(
      {
        kind: 'task',
        taskId: 't_a',
        patch: { scheduledFor: '2026-10-09', estimateMin: 90, notes: '' },
        reason: 'r',
        engineReason: 'r',
      },
      plan
    );
    assert.match(r.change, /10\/7 周三 → 10\/9 周五/);
    assert.match(r.change, /预估 45 分钟 → 1 小时 30 分/);
    // notes 在补丁里、但值和任务现在的一样（都是空），就不该出现在卡片上
    assert.equal(r.change.includes('备注'), false, `不该提没变的字段，实际：${r.change}`);
  });
});

describe('卡片上的三层：改的是谁 / 从什么变成什么 / 为什么', () => {
  const plan = planWith([{ id: 't_a', title: '通读 DP', scheduledFor: '2026-10-07', estimateMin: 45 }]);
  const row = (p: Parameters<typeof describeProposal>[0]) => describeProposal(p, plan);

  it('改期：标题是任务名，变更是「哪天 → 哪天」', () => {
    const r = row(move('t_a', '2026-10-11'));
    assert.equal(r.title, '通读 DP');
    assert.equal(r.change, '10/7 周三 → 10/11 周日');
    assert.equal(r.key, 'reschedule:t_a');
  });

  it('移回待排池说的是人话，不是 null', () => {
    assert.match(row(move('t_a', null)).change, /待排池/);
  });

  it('改时长：两边都是人话，不是裸分钟数', () => {
    const r = row({ kind: 'estimate', taskId: 't_a', estimateMin: 90, reason: 'r', engineReason: 'r' });
    assert.match(r.change, /45 分钟 → 1 小时 30 分/);
  });

  it('目标：绝不出现 JSON', () => {
    const r = row({ kind: 'goal', patch: { deadline: '2026-12-01' }, reason: 'r', engineReason: 'r' });
    assert.equal(r.title, '目标');
    assert.match(r.change, /截止日 → 12月1日/);
    assert.equal(r.change.includes('{'), false, '旧实现把 patch 用 JSON.stringify 打出来了，不能给学生看');
  });

  it('目标：优先级说成高中低', () => {
    assert.match(row({ kind: 'goal', patch: { priority: 'medium' }, reason: 'r', engineReason: 'r' }).change, /优先级 → 中/);
  });

  it('档案：说成「每周可用 N 小时」而不是字段名', () => {
    const r = row({ kind: 'profile', patch: { weeklyHours: 3 }, reason: 'r', engineReason: 'r' });
    assert.equal(r.title, '记住你的情况');
    assert.match(r.change, /每周可用 3 小时/);
  });

  it('新任务：标题是卡片自己写的那个', () => {
    const r = row({
      kind: 'addTask',
      task: { title: '加练：X', type: 'practice', estimateMin: 45, notes: '', scheduledFor: null, notBefore: null, tags: [] },
      reason: 'r',
      engineReason: 'r',
    });
    assert.equal(r.title, '加练：X');
    assert.match(r.change, /新加一张 · 待排池/);
  });

  it('任务已经不在了也画得出来（不抛）', () => {
    const r = row(move('t_没了', '2026-10-11'));
    assert.match(r.title, /已删除/);
  });

  it('没被改写时 reason 和 engineReason 一样', () => {
    const r = row(move('t_a', '2026-10-11'));
    assert.equal(r.reason, r.engineReason);
  });
});
