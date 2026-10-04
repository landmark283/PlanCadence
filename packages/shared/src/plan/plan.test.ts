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
import { emptyPlan, isoWeekKey, validatePlan } from './schema.ts';
import type { PlanFile, TaskInput } from './schema.ts';
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

describe('并发与回滚', () => {
  it('命令时间早于 meta.updated 时被拒绝', () => {
    const r = applyCommand(freshPlan(), { type: 'task.add', at: '2026-10-05T00:00:00+08:00', task: taskA });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes('早于计划更新时间'), r.error);
  });

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
