/**
 * 命令层与格式校验的自证测试。
 *
 * 这一组测试的用途不是「保证质量」，而是让 AI 能自己判断逻辑对不对——
 * 人类不需要读 commands.ts 的实现，只需要看这里是否全绿。
 *
 * 运行：pnpm test（= node --test --experimental-test-isolation=none）
 * 刻意用 node:test 而不是 vitest：沙箱内 Vite 8 在 Windows 上会调 child_process.exec('net use')，
 * 直接 EPERM；node:test 配 --experimental-test-isolation=none 全程在进程内跑，零依赖、免提权。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlanFile, Review, emptyPlan, isoWeekKey, validatePlan } from './schema.ts';
import type { TaskInput } from './schema.ts';
import { applyCommand } from './commands.ts';

const T0 = '2026-10-06T20:00:00+08:00';

function freshPlan(): PlanFile {
  return emptyPlan('plan_test', T0, '测试计划');
}

/** 断言成功并取出新计划，失败时直接把错误抛出来便于定位 */
function must(plan: PlanFile, cmd: Parameters<typeof applyCommand>[1]): PlanFile {
  const r = applyCommand(plan, cmd);
  if (!r.ok) throw new Error(`命令 ${cmd.type} 意外失败：${r.error}`);
  return r.plan;
}

const taskA: TaskInput = { id: 't_a', title: '任务 A', estimateMin: 30, type: 'read' };
const taskB: TaskInput = { id: 't_b', title: '任务 B', estimateMin: 30, type: 'read', dependsOn: ['t_a'] };

function twoTasks(): PlanFile {
  return must(must(freshPlan(), { type: 'task.add', at: T0, task: taskA }), { type: 'task.add', at: T0, task: taskB });
}

describe('格式与默认值', () => {
  it('task.add 后 version 递增，且 default 字段被补齐', () => {
    const p = freshPlan();
    const next = must(p, { type: 'task.add', at: T0, task: taskA });
    assert.equal(next.version, p.version + 1);
    assert.equal(next.tasks.length, 1);
    assert.equal(next.tasks[0]!.status, 'todo');
    assert.deepEqual(next.tasks[0]!.dependsOn, []);
    assert.equal(next.tasks[0]!.actualMin, null);
    assert.equal(next.tasks[0]!.notes, '');
  });

  it('history 是追加而不是替换', () => {
    const next = twoTasks();
    assert.equal(next.history.length, 2);
    assert.deepEqual(
      next.history.map((h) => h.cmd),
      ['task.add', 'task.add']
    );
  });
});

describe('依赖约束', () => {
  it('前置任务未完成时，不允许把后置任务标记为 done', () => {
    const r = applyCommand(twoTasks(), { type: 'task.setStatus', at: T0, taskId: 't_b', status: 'done' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes('前置任务未完成'), r.error);
  });

  it('前置任务完成后，后置任务可以标记为 done', () => {
    const afterA = must(twoTasks(), { type: 'task.setStatus', at: T0, taskId: 't_a', status: 'done' });
    const afterB = applyCommand(afterA, { type: 'task.setStatus', at: T0, taskId: 't_b', status: 'done' });
    assert.equal(afterB.ok, true);
  });

  it('删除任务时清理他人的悬空依赖', () => {
    const next = must(twoTasks(), { type: 'task.remove', at: T0, taskId: 't_a' });
    assert.equal(next.tasks.length, 1);
    assert.deepEqual(next.tasks[0]!.dependsOn, []);
    assert.equal(validatePlan(next).filter((i) => i.level === 'error').length, 0);
  });

  it('制造环状依赖会被拒绝，且原计划不被污染', () => {
    const before = twoTasks();
    const r = applyCommand(before, { type: 'task.edit', at: T0, taskId: 't_a', patch: { dependsOn: ['t_b'] } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes('环'), r.error);
    // 纯函数语义：失败不得改动传入的 plan
    assert.deepEqual(before.tasks.find((t) => t.id === 't_a')!.dependsOn, []);
    assert.equal(before.version, 3);
  });
});

describe('时钟不再参与写入判断（这是一条被删掉的规则）', () => {
  /**
   * 这里原本钉的是「命令时间早于 meta.updated 时被拒绝」。
   * 那条规则被删掉了，所以测试反过来钉**它不该复活**。
   */
  it('命令时间早于 meta.updated 不再被拒绝', () => {
    const p = must(freshPlan(), { type: 'task.add', at: T0, task: taskA });
    // 故意发一条时间在过去的命令——调试模式把日期往回拨之后就是这个情况
    const r = applyCommand(p, { type: 'task.add', at: '2026-10-05T00:00:00+08:00', task: taskB });
    assert.equal(r.ok, true, '一旦这条规则复活，把桌面日期往回拨就会变成「点了没反应」');
    if (r.ok) {
      assert.equal(r.plan.tasks.length, 2);
      assert.equal(r.plan.version, p.version + 1);
    }
  });

  it('meta.updated 会跟着命令倒退——它是逻辑时钟，不是墙上时钟', () => {
    const p = must(freshPlan(), { type: 'task.add', at: T0, task: taskA });
    const back = must(p, { type: 'task.add', at: '2026-10-05T00:00:00+08:00', task: taskB });
    assert.equal(back.meta.updated, '2026-10-05T00:00:00+08:00');
    assert.ok(back.meta.updated < p.meta.updated);
  });

  it('version 只增不减，即使命令时间是过去的', () => {
    const p = must(freshPlan(), { type: 'task.add', at: T0, task: taskA });
    const back = must(p, { type: 'task.add', at: '2026-10-05T00:00:00+08:00', task: taskB });
    assert.equal(back.version, p.version + 1);
  });
});

describe('回归补账：plan.settle', () => {
  /**
   * 一条复盘记录的夹具。
   *
   * 用 `Review.parse` 而不是手写对象字面量：手写的话，schema 每加一个字段
   * （v0.3 加了 `kind` 和 `dialogue`）就要回来改十几处，而且报的是
   * 「缺少属性」这种和测试意图无关的错。parse 会把默认值补齐。
   */
  const review = Review.parse({ at: T0, plannedTasks: 2, completedTasks: 1, notes: '' });

  /** 三项任务排在 10/08 ~ 10/10，其中 t_b 依赖 t_a */
  function overdue(): PlanFile {
    let p = twoTasks();
    p = must(p, { type: 'task.reschedule', at: T0, taskId: 't_a', scheduledFor: '2026-10-08' });
    p = must(p, { type: 'task.reschedule', at: T0, taskId: 't_b', scheduledFor: '2026-10-09' });
    return p;
  }

  it('一次结算只让版本 +1，历史只加一条', () => {
    const p = overdue();
    const next = must(p, {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: [],
      carry: 'backlog',
      review,
    });
    assert.equal(next.version, p.version + 1, '十二项各发一条命令会得到十二个版本，历史就没法看了');
    assert.equal(next.history.length, p.history.length + 1);
    assert.equal(next.history.at(-1)!.cmd, 'plan.settle');
  });

  it('backlog 把没做的移回待排池，并且不上锁', () => {
    const next = must(overdue(), {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: [],
      carry: 'backlog',
      review,
    });
    for (const t of next.tasks) {
      assert.equal(t.scheduledFor, null);
      assert.equal(t.pinned, false, '过期任务是引擎算出来的，不是学生手排的');
    }
  });

  it('done 里的项标记完成，并且不再被 carry 当作没做处理', () => {
    const next = must(overdue(), {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: ['t_a'],
      skipped: [],
      carry: 'backlog',
      review,
    });
    const a = next.tasks.find((t) => t.id === 't_a')!;
    const b = next.tasks.find((t) => t.id === 't_b')!;
    assert.equal(a.status, 'done');
    assert.equal(a.scheduledFor, '2026-10-08', '做完了就不该被动排期');
    assert.equal(b.status, 'todo');
    assert.equal(b.scheduledFor, null);
  });

  it('「放弃」用 skipped，不物理删除', () => {
    const p = overdue();
    const next = must(p, {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: ['t_b'],
      carry: 'backlog',
      review,
    });
    assert.equal(next.tasks.length, p.tasks.length, '删掉会让「主动放弃」和「从来没存在过」变成同一件事');
    const b = next.tasks.find((t) => t.id === 't_b')!;
    assert.equal(b.status, 'skipped');
    assert.equal(b.scheduledFor, '2026-10-09', '放弃是状态变化，不是排期变化');
  });

  it('carry: hold 时排期原样不动，但照样留一条记录', () => {
    const p = overdue();
    const next = must(p, {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: [],
      carry: 'hold',
      review,
    });
    assert.equal(next.tasks.find((t) => t.id === 't_a')!.scheduledFor, '2026-10-08');
    assert.equal(next.reviews.length, p.reviews.length + 1, '「我看到了，我决定不管」本身是个决定');
    assert.equal(next.version, p.version + 1);
  });

  it('carry: compress 用调用方给的排期', () => {
    const next = must(overdue(), {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: [],
      carry: 'compress',
      reschedule: [
        { taskId: 't_a', scheduledFor: '2026-10-11' },
        { taskId: 't_b', scheduledFor: '2026-10-12' },
      ],
      review,
    });
    assert.equal(next.tasks.find((t) => t.id === 't_a')!.scheduledFor, '2026-10-11');
    assert.equal(next.tasks.find((t) => t.id === 't_b')!.scheduledFor, '2026-10-12');
  });

  it('carry: compress 时引擎没排下的落到待排池，而不是凭空消失', () => {
    const next = must(overdue(), {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: [],
      carry: 'compress',
      reschedule: [{ taskId: 't_a', scheduledFor: '2026-10-11' }],
      review,
    });
    assert.equal(next.tasks.find((t) => t.id === 't_b')!.scheduledFor, null);
  });

  it('认不出来的 id 静默跳过，不让整次结算失败', () => {
    const p = overdue();
    const r = applyCommand(p, {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b', 't_已经不存在了'],
      done: ['t_已经不存在了'],
      skipped: [],
      carry: 'backlog',
      review,
    });
    assert.equal(r.ok, true, '一条对不上的 id 不该让学生丢掉其余全部的勾选');
    if (r.ok) {
      assert.equal(r.plan.tasks.find((t) => t.id === 't_a')!.scheduledFor, null);
      assert.equal(r.plan.tasks.find((t) => t.id === 't_b')!.scheduledFor, null);
    }
  });

  it('结算会留一条复盘记录，而且写清做了什么', () => {
    const next = must(overdue(), {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: ['t_a'],
      skipped: [],
      carry: 'backlog',
      review,
    });
    const last = next.reviews.at(-1)!;
    assert.equal(last.at, T0);
    assert.ok(last.adjustments.length > 0, '复盘回放要能看出这次结算做了什么');
    assert.ok(last.adjustments.some((s) => s.includes('确认完成')), last.adjustments.join('｜'));
  });

  it('结算历史里读得出结算区间', () => {
    const next = must(overdue(), {
      type: 'plan.settle',
      at: T0,
      from: '2026-10-07',
      to: '2026-10-10',
      pending: ['t_a', 't_b'],
      done: [],
      skipped: [],
      carry: 'backlog',
      review,
    });
    const summary = next.history.at(-1)!.summary;
    assert.ok(summary.includes('2026-10-07'), summary);
    assert.ok(summary.includes('2026-10-10'), summary);
  });
});

describe('plan.applyAdjustments 里的 taskPatch（学生改了建议卡）', () => {
  const one = () =>
    must(freshPlan(), {
      type: 'task.add',
      at: T0,
      task: { id: 't_a', title: '原本的标题', estimateMin: 30, type: 'read', scheduledFor: '2026-10-07' },
    });

  it('一次改好几个字段，只前进一版、只留一条历史', () => {
    const p = one();
    const next = must(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [
        {
          kind: 'taskPatch',
          taskId: 't_a',
          patch: { title: '改过的标题', estimateMin: 90, scheduledFor: '2026-10-09' },
          reason: '你自己改的',
        },
      ],
    });
    assert.equal(next.tasks[0]!.title, '改过的标题');
    assert.equal(next.tasks[0]!.estimateMin, 90);
    assert.equal(next.tasks[0]!.scheduledFor, '2026-10-09');
    assert.equal(next.version, p.version + 1);
    assert.equal(next.history.length, p.history.length + 1);
  });

  it('和 task.edit 共用同一份校验：空标题照样被拒', () => {
    const p = one();
    const r = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [{ kind: 'taskPatch', taskId: 't_a', patch: { title: '' }, reason: 'r' }],
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /修改不合法/);
    assert.equal(p.tasks[0]!.title, '原本的标题', '被拒之后计划不能被改动');
  });

  it('负时长照样被拒', () => {
    const p = one();
    assert.equal(
      applyCommand(p, {
        type: 'plan.applyAdjustments',
        at: T0,
        applied: [{ kind: 'taskPatch', taskId: 't_a', patch: { estimateMin: -5 }, reason: 'r' }],
      }).ok,
      false
    );
  });

  it('任务不存在时被拒', () => {
    const p = one();
    assert.equal(
      applyCommand(p, {
        type: 'plan.applyAdjustments',
        at: T0,
        applied: [{ kind: 'taskPatch', taskId: 't_没了', patch: { estimateMin: 30 }, reason: 'r' }],
      }).ok,
      false
    );
  });

  it('档案补丁并进同一条命令（一次应用是原子的）', () => {
    const p = one();
    const next = must(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [
        { kind: 'taskPatch', taskId: 't_a', patch: { estimateMin: 60 }, reason: 'r' },
        { kind: 'profile', patch: { weeklyHours: 3 }, reason: '每周只有 3 小时了' },
      ],
    });
    assert.equal(next.tasks[0]!.estimateMin, 60);
    assert.deepEqual(next.profile, { weeklyHours: 3 });
    assert.equal(next.version, p.version + 1, '任务和档案改在同一条命令里，只推一版');
  });

  it('档案是合并不是替换：没提到的字段保留', () => {
    const p = { ...one(), profile: { level: 'basic', weeklyHours: 5 } };
    const next = must(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [{ kind: 'profile', patch: { weeklyHours: 3 }, reason: 'r' }],
    });
    assert.deepEqual(next.profile, { level: 'basic', weeklyHours: 3 });
  });
});

describe('并发与回滚', () => {
  it('回滚产生新的 version，历史只增不减', () => {
    const v1 = freshPlan();
    const v2 = must(v1, { type: 'task.add', at: T0, task: taskA });
    const v3 = must(v2, { type: 'task.add', at: T0, task: taskB });
    const rolled = must(v3, { type: 'plan.restore', at: T0, snapshot: v1 });
    assert.equal(rolled.version, v3.version + 1);
    assert.equal(rolled.tasks.length, 0);
    assert.equal(rolled.history.length, v3.history.length + 1);
    assert.equal(rolled.history.at(-1)!.cmd, 'plan.restore');
  });

  it('不能回滚到不早于当前的版本', () => {
    const v2 = must(freshPlan(), { type: 'task.add', at: T0, task: taskA });
    const r = applyCommand(v2, { type: 'plan.restore', at: T0, snapshot: v2 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes('只能回滚到更早的版本'), r.error);
  });
});

describe('预算与提醒', () => {
  it('周排期超预算只产生 warn，不阻断', () => {
    const r = applyCommand(freshPlan(), {
      type: 'task.add',
      at: T0,
      task: { id: 't_big', title: '大任务', estimateMin: 900, type: 'practice', scheduledFor: '2026-10-07' },
    });
    // 默认 weeklyMinutes = 300，900 分钟必然超
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.warnings.length > 0);
  });

  it('isoWeekKey 把同一 ISO 周的日期归到同一键', () => {
    // 2026-10-05 是周一（大赛通知里的报名截止日）
    assert.equal(isoWeekKey('2026-10-05'), isoWeekKey('2026-10-11'));
    assert.notEqual(isoWeekKey('2026-10-05'), isoWeekKey('2026-10-12'));
    assert.match(isoWeekKey('2026-10-05'), /^\d{4}-W\d{2}$/);
  });

  /**
   * 这一条来自一次真实观察：学生每周只有一个晚上、中间还夹着一整周考试周，
   * 容量不够时引擎会把任务一路顺延，**顺延到目标截止日之后**，
   * 而当时没有任何一处会指出来。「排得不优」可以忍，「计划本身完不成」不能不说。
   */
  it('任务排在目标截止日之后会被指出来', () => {
    const withDeadline = must(freshPlan(), { type: 'goal.update', at: T0, patch: { deadline: '2026-10-10' } });
    const late = must(withDeadline, {
      type: 'task.add',
      at: T0,
      task: { id: 't_late', title: '来不及的任务', estimateMin: 30, type: 'read', scheduledFor: '2026-11-23' },
    });
    const warns = validatePlan(late).filter((i) => i.message.includes('晚于目标截止日'));
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.level, 'warn', '只提醒不阻断——容量确实不够时硬拦会让计划根本存不下来');
  });

  it('没有截止日时不做这项检查', () => {
    const p = must(freshPlan(), {
      type: 'task.add',
      at: T0,
      task: { id: 't_far', title: '远期任务', estimateMin: 30, type: 'read', scheduledFor: '2027-01-01' },
    });
    assert.equal(validatePlan(p).filter((i) => i.message.includes('晚于目标截止日')).length, 0);
  });

  it('排在截止日当天不算越界', () => {
    const withDeadline = must(freshPlan(), { type: 'goal.update', at: T0, patch: { deadline: '2026-10-10' } });
    const onTime = must(withDeadline, {
      type: 'task.add',
      at: T0,
      task: { id: 't_ok', title: '卡点完成', estimateMin: 30, type: 'read', scheduledFor: '2026-10-10' },
    });
    assert.equal(validatePlan(onTime).filter((i) => i.message.includes('晚于目标截止日')).length, 0);
  });
});

describe('手动改期默认上锁（保护「协商」这个卖点）', () => {
  const withTask = () => must(freshPlan(), { type: 'task.add', at: T0, task: taskA });

  it('新任务默认未上锁', () => {
    assert.equal(withTask().tasks[0]!.pinned, false);
  });

  it('task.reschedule 默认把任务锁定', () => {
    const moved = must(withTask(), { type: 'task.reschedule', at: T0, taskId: 't_a', scheduledFor: '2026-10-20' });
    assert.equal(moved.tasks[0]!.scheduledFor, '2026-10-20');
    assert.equal(moved.tasks[0]!.pinned, true);
  });

  it('可以显式要求不上锁', () => {
    const moved = must(withTask(), {
      type: 'task.reschedule',
      at: T0,
      taskId: 't_a',
      scheduledFor: '2026-10-20',
      pin: false,
    });
    assert.equal(moved.tasks[0]!.pinned, false);
  });

  it('task.setPinned 能解锁', () => {
    const locked = must(freshPlan(), { type: 'task.add', at: T0, task: { ...taskA, pinned: true } });
    assert.equal(locked.tasks[0]!.pinned, true);
    const unlocked = must(locked, { type: 'task.setPinned', at: T0, taskId: 't_a', pinned: false });
    assert.equal(unlocked.tasks[0]!.pinned, false);
  });
});

describe('最早可安排日（notBefore）', () => {
  const withTask = () => must(freshPlan(), { type: 'task.add', at: T0, task: taskA });

  it('新任务默认为 null', () => {
    assert.equal(withTask().tasks[0]!.notBefore, null);
  });

  it('task.setNotBefore 可设置，也可清除', () => {
    const set = must(withTask(), { type: 'task.setNotBefore', at: T0, taskId: 't_a', notBefore: '2026-11-09' });
    assert.equal(set.tasks[0]!.notBefore, '2026-11-09');
    const cleared = must(set, { type: 'task.setNotBefore', at: T0, taskId: 't_a', notBefore: null });
    assert.equal(cleared.tasks[0]!.notBefore, null);
  });

  it('task.edit 也能改 notBefore', () => {
    const edited = must(withTask(), { type: 'task.edit', at: T0, taskId: 't_a', patch: { notBefore: '2026-12-01' } });
    assert.equal(edited.tasks[0]!.notBefore, '2026-12-01');
  });

  it('排期早于 notBefore 时校验给出 warn，但不阻断', () => {
    const p = must(withTask(), { type: 'task.setNotBefore', at: T0, taskId: 't_a', notBefore: '2026-11-09' });
    const scheduled = must(p, { type: 'task.reschedule', at: T0, taskId: 't_a', scheduledFor: '2026-10-20' });
    const warns = validatePlan(scheduled).filter((i) => i.message.includes('最早可安排日'));
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.level, 'warn');
  });
});

describe('赛事没有截止日不再是警告（这是一条被删掉的规则）', () => {
  /**
   * 真机上报过 `Encountered two children with the same key，
   * 赛事缺少截止日期，无法显示倒计时` —— 根因是复盘页拿警告**文案**当 key，
   * 而那条规则对每个没有截止日的赛事各报一次，文案一模一样。
   *
   * 但更根本的问题是那条规则本身：工具调用上线后「没有截止日的赛事」是**正常状态**
   * （蓝桥杯之类的只有官网，我们拒绝编日期），每份计划都带 3–7 条一模一样的警告。
   * 所以规则删了，信息挪到资源卡上（「未记录截止日 · 以官网为准」）。
   *
   * 这条测试钉住的是「别再加回来」。
   */
  const withContests = (n: number): PlanFile => {
    const p = freshPlan();
    for (let i = 0; i < n; i++) {
      const r = applyCommand(p, {
        type: 'resource.add',
        at: T0,
        resource: {
          id: `r_contest_${i}`,
          title: `赛事 ${i}`,
          url: `https://example.com/contest/${i}`,
          kind: 'contest',
          deadline: null,
        },
      });
      if (!r.ok) throw new Error(r.error);
      p.resources = r.plan.resources;
    }
    return p;
  };

  it('三个没有截止日的赛事，一条警告都不该有', () => {
    const warns = validatePlan(withContests(3)).filter((i) => i.level === 'warn');
    assert.deepEqual(warns, [], `不该再报赛事缺日期的警告：${warns.map((w) => w.message).join('；')}`);
  });

  it('顺便确认：警告的 path 是唯一的，所以键永远该用 path 而不是文案', () => {
    // 真有一条规则对多个对象各报一次时，path 必须能区分它们——
    // 复盘页的 key 现在就是 `fmt:${path}`
    const p = must(withContests(2), { type: 'task.add', at: T0, task: taskA });
    const warns = validatePlan(p).filter((i) => i.level === 'warn');
    const paths = warns.map((w) => w.path);
    assert.equal(new Set(paths).size, paths.length, `path 有重复：${paths.join(', ')}`);
  });
});

describe('工具调用：plan.attachResources', () => {
  const res = (id: string, url = `https://example.com/${id}`) => ({
    id,
    title: `资料 ${id}`,
    url,
    kind: 'article' as const,
  });

  const oneTask = () => must(freshPlan(), { type: 'task.add', at: T0, task: taskA });

  it('一次动作 = 一条历史 + 一次版本递增（不是每条资源一条）', () => {
    const p = oneTask();
    const next = must(p, {
      type: 'plan.attachResources',
      at: T0,
      resources: [res('r1'), res('r2'), res('r3')],
      links: [{ taskId: 't_a', resourceIds: ['r1', 'r2'] }],
    });
    assert.equal(next.resources.length, 3);
    assert.equal(next.version, p.version + 1, '应该只加一个版本');
    assert.equal(next.history.length, p.history.length + 1, '应该只加一条历史');
    assert.deepEqual(next.tasks[0]!.resourceIds, ['r1', 'r2']);
  });

  it('幂等：连点两次不报错，也不产生重复条目', () => {
    const cmd = {
      type: 'plan.attachResources' as const,
      at: T0,
      resources: [res('r1')],
      links: [{ taskId: 't_a', resourceIds: ['r1'] }],
    };
    const once = must(oneTask(), cmd);
    const twice = must(once, cmd);
    assert.equal(twice.resources.length, 1, '资源重复了');
    assert.deepEqual(twice.tasks[0]!.resourceIds, ['r1'], '挂载重复了');
    // 第二次仍然算一次成功操作，摘要说得明白
    assert.match(twice.history.at(-1)!.summary, /没有变化|一样/);
  });

  it('已有的挂载会合并而不是覆盖（学生手动挂过的不该被冲掉）', () => {
    // r0 必须先作为资源进计划，否则 task.edit 会把计划改成悬空引用，
    // 命令层校验直接拦下——这本身也说明「引用必须存在」这条护栏是活的
    const withR0 = must(oneTask(), {
      type: 'plan.attachResources',
      at: T0,
      resources: [res('r0')],
      links: [{ taskId: 't_a', resourceIds: ['r0'] }],
    });
    const next = must(withR0, {
      type: 'plan.attachResources',
      at: T0,
      resources: [res('r1')],
      links: [{ taskId: 't_a', resourceIds: ['r1'] }],
    });
    assert.deepEqual(next.tasks[0]!.resourceIds, ['r0', 'r1']);
  });

  it('单条资源不合法只跳过它，其余照挂——一条坏数据不该拖垮整批', () => {
    const next = must(oneTask(), {
      type: 'plan.attachResources',
      at: T0,
      resources: [res('r_ok'), { id: 'r_bad', title: 'x', url: '不是网址', kind: 'article' as const }],
      links: [{ taskId: 't_a', resourceIds: ['r_ok', 'r_bad'] }],
    });
    assert.deepEqual(next.resources.map((r) => r.id), ['r_ok']);
    // 坏资源没进去，它的挂载就不能留下——否则是悬空引用
    assert.deepEqual(next.tasks[0]!.resourceIds, ['r_ok']);
  });

  it('links 指向不存在的任务时静默忽略，不报错（任务可能已被删）', () => {
    const next = must(oneTask(), {
      type: 'plan.attachResources',
      at: T0,
      resources: [res('r1')],
      links: [{ taskId: 't_不存在', resourceIds: ['r1'] }],
    });
    assert.equal(next.resources.length, 1);
    assert.deepEqual(next.tasks[0]!.resourceIds, []);
  });

  it('挂完之后整份计划仍然过得了校验', () => {
    const next = must(oneTask(), {
      type: 'plan.attachResources',
      at: T0,
      resources: [res('r1')],
      links: [{ taskId: 't_a', resourceIds: ['r1'] }],
    });
    assert.deepEqual(validatePlan(next).filter((i) => i.level === 'error'), []);
  });
});

/**
 * task.edit 的边界。
 *
 * 这一段盯着的是一个**曾经存在的洞**：`task.edit` 原先只有一句
 * `Object.assign(t, cmd.patch)`，没有任何字段校验，而 `validatePlan` 不管字段合法性
 * （它管引用、环、周预算、档期冲突）。于是 `patch: { title: '' }` 会
 * `ok: true` 地写进磁盘，**下一次启动解析这份文件就失败**，
 * 界面变成「设备上的计划文件无法解析」并暂停写入。
 *
 * 在此之前它是潜伏的（没有界面调用 task.edit）；编辑页是第一个调用者，
 * 所以这些用例是编辑页上线的前提。
 */
describe('task.edit 的字段校验（曾经的洞）', () => {
  const withOne = () => must(freshPlan(), { type: 'task.add', at: T0, task: { id: 't_a', title: '原本的标题', estimateMin: 30, type: 'read' } });

  it('空标题被拒，而且计划没被改动', () => {
    const p = withOne();
    const r = applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { title: '' } });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /修改不合法/);
    assert.equal(p.tasks[0]!.title, '原本的标题');
  });

  it('全是空白的标题 schema 拦不住——所以界面侧必须 trim', () => {
    const p = withOne();
    // zod 的 min(1) 看的是长度，' ' 长度是 1，所以这一条**会通过**。
    // 把它写下来是因为它是个陷阱：真正的把关在 task-patch.ts 的 taskPatch()（那里 trim）
    const r = applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { title: ' ' } });
    assert.equal(r.ok, true);
  });

  it('负数或零时长被拒', () => {
    const p = withOne();
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { estimateMin: 0 } }).ok, false);
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { estimateMin: -30 } }).ok, false);
  });

  it('小数时长被拒（estimateMin 是整分钟）', () => {
    const p = withOne();
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { estimateMin: 30.5 } }).ok, false);
  });

  it('超长备注被拒', () => {
    const p = withOne();
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { notes: 'x'.repeat(2001) } }).ok, false);
  });

  it('超长标题被拒', () => {
    const p = withOne();
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { title: 'x'.repeat(161) } }).ok, false);
  });

  it('非法日期被拒', () => {
    const p = withOne();
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { scheduledFor: '2026/10/20' } }).ok, false);
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { notBefore: '明天' } }).ok, false);
  });

  it('指向不存在的前置任务被拒（由 validatePlan 兜底）', () => {
    const p = withOne();
    const r = applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { dependsOn: ['t_不存在'] } });
    assert.equal(r.ok, false);
  });

  it('成环被拒', () => {
    const p = twoTasks(); // t_b 依赖 t_a
    const r = applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { dependsOn: ['t_b'] } });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /环/);
  });

  it('不存在的任务被拒', () => {
    const p = withOne();
    assert.equal(applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_没有', patch: { title: 'x' } }).ok, false);
  });

  it('合法 patch 写进去了，而且只 +1 版、只留一条历史', () => {
    const p = withOne();
    const next = must(p, {
      type: 'task.edit',
      at: T0,
      taskId: 't_a',
      patch: { title: '新标题', estimateMin: 60, scheduledFor: '2026-10-20', pinned: true, tags: ['tag_focus'] },
    });
    assert.equal(next.tasks[0]!.title, '新标题');
    assert.equal(next.tasks[0]!.estimateMin, 60);
    assert.equal(next.tasks[0]!.scheduledFor, '2026-10-20');
    assert.deepEqual(next.tasks[0]!.tags, ['tag_focus']);
    assert.equal(next.version, p.version + 1, '一次编辑只前进一版');
    assert.equal(next.history.length, p.history.length + 1, '一次编辑只留一条历史');
  });

  it('改期不会顺手上锁——默认值是界面侧的事（task-patch 的 withScheduledFor）', () => {
    const p = withOne();
    const next = must(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { scheduledFor: '2026-10-20' } });
    assert.equal(next.tasks[0]!.pinned, false);
  });

  it('patch 里没提到的字段一个字都不动', () => {
    const p = must(withOne(), { type: 'task.edit', at: T0, taskId: 't_a', patch: { notes: '写点备注' } });
    const next = must(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { estimateMin: 90 } });
    assert.equal(next.tasks[0]!.notes, '写点备注');
    assert.equal(next.tasks[0]!.title, '原本的标题');
    assert.equal(next.tasks[0]!.type, 'read');
  });

  it('删除任务时，指向它的前置引用被清掉', () => {
    const next = must(twoTasks(), { type: 'task.remove', at: T0, taskId: 't_a' });
    assert.deepEqual(next.tasks[0]!.dependsOn, []);
  });
});

describe('标记字段（tags）', () => {
  it('新任务默认没有标记', () => {
    const next = must(freshPlan(), { type: 'task.add', at: T0, task: { id: 't_a', title: 'A', estimateMin: 30, type: 'read' } });
    assert.deepEqual(next.tasks[0]!.tags, []);
  });

  it('认不出来的标记 id 不会让命令失败（渲染时才跳过）', () => {
    const p = must(freshPlan(), { type: 'task.add', at: T0, task: { id: 't_a', title: 'A', estimateMin: 30, type: 'read' } });
    // 合法 id、但目录里没有这一条。这正是「陈旧标记」的样子
    const next = must(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { tags: ['tag_ghost'] } });
    assert.deepEqual(next.tasks[0]!.tags, ['tag_ghost'], 'id 存下来了，画不出来是渲染的事');
    assert.deepEqual(validatePlan(next).filter((i) => i.level === 'error'), []);
  });

  it('标记 id 必须满足 Id 正则', () => {
    const p = must(freshPlan(), { type: 'task.add', at: T0, task: { id: 't_a', title: 'A', estimateMin: 30, type: 'read' } });
    assert.equal(
      applyCommand(p, { type: 'task.edit', at: T0, taskId: 't_a', patch: { tags: ['Tag-Bad'] } }).ok,
      false
    );
  });

  it('plan.tags 目录默认是空的，但存在', () => {
    assert.deepEqual(freshPlan().tags, []);
  });

  it('自定义目录能过校验，且同 id 不重复', () => {
    const p = { ...freshPlan(), tags: [{ id: 'tag_mine', label: '我的', tone: 'success' as const }] };
    const parsed = PlanFile.safeParse(p);
    assert.equal(parsed.success, true);
    assert.deepEqual(validatePlan(PlanFile.parse(p)).filter((i) => i.level === 'error'), []);
  });
});
