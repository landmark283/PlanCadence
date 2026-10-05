/**
 * 回归补账的测试。
 *
 * 这里要钉住的是「过几天再打开时，界面拿到的数字对不对」。
 * 数字数错是这一屏唯一不能犯的错，所以区间边界、状态过滤、依赖计数
 * 各有一组测试盯着；另外还盯着一个很容易写成 0 的容量计算（见下面那条注释）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlanFile } from './schema.ts';
import type { TaskInput } from './schema.ts';
import { settleFacts, settlePlanText } from './settle.ts';

const MID = '2026-10-19T09:00:00+08:00';
const FROM = '2026-10-14';
const TO = '2026-10-19';

type Extra = {
  deadline?: string | null;
  milestones?: unknown[];
  availableSlots?: unknown[];
  weeklyMinutes?: number;
};

function planOf(tasks: TaskInput[], extra: Extra = {}): PlanFile {
  return PlanFile.parse({
    schema: 'studyplan/v1',
    id: 'plan_test',
    version: 1,
    meta: { title: '测试计划', created: MID, updated: MID },
    goal: {
      statement: '目标',
      successCriteria: [],
      deadline: extra.deadline ?? null,
      priority: 'medium',
    },
    constraints: {
      weeklyMinutes: extra.weeklyMinutes ?? 300,
      availableSlots: extra.availableSlots ?? [],
      maxSessionMinutes: 90,
      blackouts: [],
    },
    milestones: extra.milestones ?? [],
    tasks,
  });
}

const t = (id: string, day: string | null, over: Partial<TaskInput> = {}): TaskInput => ({
  id,
  title: `任务 ${id}`,
  estimateMin: 30,
  type: 'read',
  scheduledFor: day,
  ...over,
});

describe('settleFacts 的触发条件', () => {
  it('没有隔天就没有账可结', () => {
    const p = planOf([t('t_a', '2026-10-19')]);
    assert.equal(settleFacts(p, TO, TO), null, '同一天打开不该弹出结账页');
  });

  it('日期往回拨（调试模式）也不结账', () => {
    const p = planOf([t('t_a', '2026-10-19')]);
    assert.equal(settleFacts(p, TO, FROM), null, '往回拨是调试动作，不是一段需要结算的时间');
  });

  it('结算区间是左开右闭：上次打开那天不算欠账', () => {
    const p = planOf([t('t_on_from', FROM), t('t_inside', '2026-10-16'), t('t_on_to', TO)]);
    const facts = settleFacts(p, FROM, TO)!;
    const ids = facts.pending.map((x) => x.taskId);
    assert.deepEqual(ids.sort(), ['t_inside', 't_on_to'], 'FROM 那天的任务是上次打开时就该看到的');
  });

  it('区间之外的任务不算', () => {
    const p = planOf([t('t_before', '2026-10-13'), t('t_after', '2026-10-20'), t('t_inside', '2026-10-16')]);
    assert.deepEqual(settleFacts(p, FROM, TO)!.pending.map((x) => x.taskId), ['t_inside']);
  });

  it('待排池里的任务不算——它没有"本该完成"的那一天', () => {
    const p = planOf([t('t_pool', null)]);
    assert.deepEqual(settleFacts(p, FROM, TO)!.pending, []);
  });
});

describe('settleFacts 的清单', () => {
  it('已完成和已放弃的都不算欠账', () => {
    const p = planOf([
      t('t_done', '2026-10-15', { status: 'done' }),
      t('t_skipped', '2026-10-16', { status: 'skipped' }),
      t('t_todo', '2026-10-17'),
      t('t_doing', '2026-10-18', { status: 'doing' }),
    ]);
    const facts = settleFacts(p, FROM, TO)!;
    assert.deepEqual(facts.pending.map((x) => x.taskId).sort(), ['t_doing', 't_todo']);
    assert.equal(facts.doneCount, 1);
  });

  it('doneCount 只数区间内完成的', () => {
    const p = planOf([
      t('t_done_in', '2026-10-16', { status: 'done' }),
      t('t_done_out', '2026-10-10', { status: 'done' }),
      t('t_todo', '2026-10-17'),
    ]);
    assert.equal(settleFacts(p, FROM, TO)!.doneCount, 1);
  });

  it('挡着的后续任务是按传递闭包数的', () => {
    const p = planOf([
      t('t_a', '2026-10-15'),
      t('t_b', '2026-10-25', { dependsOn: ['t_a'] }),
      t('t_c', '2026-10-30', { dependsOn: ['t_b'] }),
    ]);
    const facts = settleFacts(p, FROM, TO)!;
    assert.equal(facts.pending.find((x) => x.taskId === 't_a')!.blocks, 2, '只数直接依赖会严重低估后果');
  });

  it('已经做完的后继不算"挡着"', () => {
    const p = planOf([
      t('t_a', '2026-10-15'),
      t('t_b', '2026-10-25', { dependsOn: ['t_a'], status: 'done' }),
      t('t_c', '2026-10-30', { dependsOn: ['t_b'] }),
    ]);
    assert.equal(settleFacts(p, FROM, TO)!.pending.find((x) => x.taskId === 't_a')!.blocks, 0);
  });

  it('挡得多的排前面——学生先要看到后果最大的', () => {
    const p = planOf([
      t('t_alone', '2026-10-15'),
      t('t_blocking', '2026-10-16'),
      t('t_next', '2026-10-25', { dependsOn: ['t_blocking'] }),
    ]);
    assert.equal(settleFacts(p, FROM, TO)!.pending[0]!.taskId, 't_blocking');
  });

  it('依赖成环也不会死循环', () => {
    const p = planOf([
      t('t_a', '2026-10-15', { dependsOn: ['t_b'] }),
      t('t_b', '2026-10-16', { dependsOn: ['t_a'] }),
    ]);
    assert.doesNotThrow(() => settleFacts(p, FROM, TO));
  });
});

describe('settleFacts 的风险提示', () => {
  it('目标截止日过去了', () => {
    const p = planOf([t('t_a', '2026-10-16')], { deadline: '2026-10-17' });
    assert.equal(settleFacts(p, FROM, TO)!.pastGoalDeadline, true);
  });

  it('目标截止日还没到就不提', () => {
    const p = planOf([t('t_a', '2026-10-16')], { deadline: '2026-12-01' });
    assert.equal(settleFacts(p, FROM, TO)!.pastGoalDeadline, false);
  });

  it('截止日已过但里面还有没做完的事的里程碑才算有风险', () => {
    const p = planOf([t('t_a', '2026-10-16', { milestoneId: 'm_1' }), t('t_b', '2026-10-30', { milestoneId: 'm_2' })], {
      milestones: [
        { id: 'm_1', title: '里程碑一', due: '2026-10-17' },
        { id: 'm_2', title: '里程碑二', due: '2026-12-01' },
      ],
    });
    assert.deepEqual(settleFacts(p, FROM, TO)!.atRiskMilestones.map((m) => m.id), ['m_1']);
  });
});

describe('「压缩到接下来几天」的预览', () => {
  it('能排下时不喊超载', () => {
    const p = planOf([t('t_a', '2026-10-16'), t('t_b', '2026-10-17')]);
    const facts = settleFacts(p, FROM, TO)!;
    assert.equal(facts.compress.overloaded, false);
    assert.ok(facts.compress.plan.length > 0, '要给出真的排期，不能只在界面上画个饼');
  });

  it('排不下时如实说', () => {
    const p = planOf([t('t_a', '2026-10-16', { estimateMin: 900 })], { weeklyMinutes: 300 });
    assert.equal(settleFacts(p, FROM, TO)!.compress.overloaded, true);
  });

  it('没有配置可用时段时，容量按周预算算，而不是算成 0', () => {
    /**
     * 这是一个很容易写错的地方：`availableMinutes` 是按 `availableSlots` 展开的，
     * 没有时段就返回 0。如果这里直接用它，界面会对着一个其实排得下的方案
     * 一直喊「会超载」。所以没有时段时必须退回周预算口径——
     * 和 `proposeReschedule` 在同样情况下的退化保持一致。
     */
    const p = planOf([t('t_a', '2026-10-16')]);
    const c = settleFacts(p, FROM, TO)!.compress;
    assert.equal(c.capacity, 300);
    assert.equal(c.overloaded, false);
  });

  it('压缩天数封顶 7 天——丢了 30 天不该压进接下来 30 天', () => {
    const p = planOf([t('t_a', '2026-09-20')]);
    assert.equal(settleFacts(p, '2026-09-19', TO)!.compress.horizonDays, 7);
  });

  it('压缩天数跟着丢掉的时长走（少于 7 天时）', () => {
    const p = planOf([t('t_a', '2026-10-16')]);
    assert.equal(settleFacts(p, '2026-10-16', TO)!.compress.horizonDays, 3);
  });

  it('压缩排期覆盖的是那批没做的任务', () => {
    const p = planOf([t('t_a', '2026-10-16'), t('t_b', '2026-10-17'), t('t_other', '2026-10-30')]);
    const ids = settleFacts(p, FROM, TO)!.compress.plan.map((x) => x.taskId).sort();
    assert.deepEqual(ids, ['t_a', 't_b']);
  });
});

describe('本机叙述', () => {
  it('数字必须和清单一致', () => {
    const p = planOf([
      t('t_a', '2026-10-16'),
      t('t_b', '2026-10-17'),
      t('t_c', '2026-10-18', { dependsOn: ['t_a'] }),
      t('t_done', '2026-10-15', { status: 'done' }),
    ]);
    const facts = settleFacts(p, FROM, TO)!;
    const text = settlePlanText(facts);
    assert.ok(text.includes('5 天'), text);
    assert.ok(text.includes('3 项'), text);
    assert.ok(text.includes('1 项挡着'), text);
  });

  it('一件事都没有时不编故事', () => {
    const p = planOf([t('t_done', '2026-10-16', { status: 'done' })]);
    const text = settlePlanText(settleFacts(p, FROM, TO)!);
    assert.ok(text.includes('都处理过了'), text);
  });
});
