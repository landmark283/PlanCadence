/**
 * `talk` 契约的测试。
 *
 * 这一组全部冲着**把关**去：提示词里的规则没有约束力，
 * 真正拦住「猜着改」「编 id」「排到过去」的是 `resolveTalkOutput`。
 * 所以每条硬规则都要有一个「模型不听话时它会怎样」的用例。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, type PlanFile } from '../plan/schema.ts';
import { applyCommand } from '../plan/commands.ts';
import { QuestionSpec } from './interview.ts';
import {
  MAX_TALK_PROPOSALS,
  MAX_TALK_QUESTIONS,
  TalkInput,
  TalkOutput,
  answerTurn,
  buildTalkMessages,
  clarifyRounds,
  resolveTalkOutput,
} from './talk.ts';

const T0 = '2026-10-05T09:00:00+08:00';
const TODAY = '2026-10-05';

function planWith(): PlanFile {
  let p = emptyPlan('plan_talk', T0, '测试计划');
  const r = applyCommand(p, {
    type: 'task.add',
    at: T0,
    task: { id: 't_a', title: '通读 DP', estimateMin: 45, type: 'read', scheduledFor: '2026-10-07' },
  });
  if (!r.ok) throw new Error(r.error);
  p = r.plan;
  const r2 = applyCommand(p, {
    type: 'constraints.update',
    at: T0,
    patch: { blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }] },
  });
  if (!r2.ok) throw new Error(r2.error);
  return r2.plan;
}

const out = (o: Partial<ReturnType<typeof TalkOutput.parse>>) => TalkOutput.parse(o);

/** 用 `parse` 补默认值，而不是手写全字段——schema 加字段时不用回来改这里 */
const question = (id = 'q_1') =>
  QuestionSpec.parse({
    id,
    kind: 'single',
    prompt: '周三还是周六？',
    why: '这决定我把它排在哪天。',
    options: [{ value: 'wed', label: '周三' }, { value: 'sat', label: '周六' }],
  });

describe('把模型给的东西过一遍', () => {
  const plan = planWith();

  it('合法的提案照原样通过', () => {
    const r = resolveTalkOutput(
      out({
        understanding: '把 DP 挪到周六。',
        proposals: [
          { kind: 'reschedule', taskId: 't_a', scheduledFor: '2026-10-10', reason: '你周六有空', engineReason: '你周六有空' },
        ],
      }),
      plan,
      TODAY
    );
    assert.equal(r.proposals.length, 1);
    assert.equal(r.refusals.length, 0);
    assert.equal(r.dropped, 0);
  });

  it('编出来的 taskId 被丢掉，并把理由说给学生听', () => {
    // 用**形状合法但计划里没有**的 id：模型编的多半长这样（t_09），
    // 而不是带中文字符串（那种在 zod 解析那一层就被挡掉了）
    const r = resolveTalkOutput(
      out({
        understanding: '挪一下。',
        proposals: [
          { kind: 'reschedule', taskId: 't_ghost', scheduledFor: '2026-10-10', reason: 'r', engineReason: 'r' },
        ],
      }),
      plan,
      TODAY
    );
    assert.equal(r.proposals.length, 0);
    assert.equal(r.dropped, 1);
    assert.equal(r.refusals.length, 1, '少了一条却不说，学生只会觉得它没听懂');
  });

  it('排到过去的日期被丢掉', () => {
    const r = resolveTalkOutput(
      out({
        understanding: '挪一下。',
        proposals: [
          { kind: 'reschedule', taskId: 't_a', scheduledFor: '2026-09-01', reason: 'r', engineReason: 'r' },
        ],
      }),
      plan,
      TODAY
    );
    assert.equal(r.proposals.length, 0);
    assert.match(r.refusals.join(''), /过去/);
  });

  it('排到不可用区间被丢掉，理由里带上「期中考试周」', () => {
    const r = resolveTalkOutput(
      out({
        understanding: '挪到那周。',
        proposals: [
          { kind: 'reschedule', taskId: 't_a', scheduledFor: '2026-11-03', reason: 'r', engineReason: 'r' },
        ],
      }),
      plan,
      TODAY
    );
    assert.equal(r.proposals.length, 0);
    assert.match(r.refusals.join(''), /期中考试周/);
  });

  it('一条坏的不会拖垮整批：五条里坏一条，另外四条照给', () => {
    const good = (id: string, day: string) => ({
      kind: 'reschedule' as const,
      taskId: 't_a',
      scheduledFor: day,
      reason: id,
      engineReason: id,
    });
    const r = resolveTalkOutput(
      out({
        understanding: '挪一挪。',
        proposals: [
          good('a', '2026-10-08'),
          good('b', '2026-10-09'),
          { kind: 'estimate', taskId: 't_没有', estimateMin: 60, reason: 'r', engineReason: 'r' },
          good('c', '2026-10-11'),
        ],
      }),
      plan,
      TODAY
    );
    // 同一个任务的多条改期会被 proposalKey 去重的是界面层；这里先确认坏的那条没拖垮别的
    assert.ok(r.proposals.length >= 3);
    assert.equal(r.dropped, 1);
  });

  it('格式就不对的提案被丢掉，不影响别的', () => {
    const r = resolveTalkOutput(
      out({
        understanding: 'x',
        proposals: [{ kind: 'reschedule' }, { kind: '完全没这个种类', taskId: 't_a' }],
      }),
      plan,
      TODAY
    );
    assert.equal(r.proposals.length, 0);
    assert.equal(r.dropped, 2);
  });
});

describe('硬规则：有澄清问题就绝不同时给提案', () => {
  const plan = planWith();

  it('两样都给时，提案被砍掉，问题留下', () => {
    const r = resolveTalkOutput(
      out({
        understanding: '我不太确定你说的是哪件事。',
        questions: [question()],
        proposals: [
          { kind: 'reschedule', taskId: 't_a', scheduledFor: '2026-10-10', reason: 'r', engineReason: 'r' },
        ],
      }),
      plan,
      TODAY
    );
    assert.equal(r.questions.length, 1);
    assert.equal(r.proposals.length, 0, '猜着改是禁止的，不是「尽量别」');
    assert.equal(r.dropped, 1);
  });

  it('只给问题时不动提案（本来就是空的）', () => {
    const r = resolveTalkOutput(out({ understanding: 'x', questions: [question()] }), plan, TODAY);
    assert.equal(r.questions.length, 1);
    assert.equal(r.proposals.length, 0);
    assert.equal(r.dropped, 0);
  });

  it('问题最多两个，多出来的砍掉', () => {
    const r = resolveTalkOutput(
      out({ understanding: 'x', questions: [question('q_1'), question('q_2'), question('q_3')] }),
      plan,
      TODAY
    );
    assert.equal(r.questions.length, MAX_TALK_QUESTIONS);
  });

  it('提案最多六条', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      kind: 'estimate' as const,
      taskId: 't_a',
      estimateMin: 15 * (i + 1),
      reason: `r${i}`,
      engineReason: `r${i}`,
    }));
    const r = resolveTalkOutput(out({ understanding: 'x', proposals: many }), plan, TODAY);
    assert.equal(r.proposals.length, MAX_TALK_PROPOSALS);
    assert.ok(r.dropped >= 4);
  });

  it('模型明说做不到的事原样带出来', () => {
    const r = resolveTalkOutput(
      out({ understanding: 'x', refusals: ['删掉整份计划重做不在我能碰的范围里'] }),
      plan,
      TODAY
    );
    assert.deepEqual(r.refusals, ['删掉整份计划重做不在我能碰的范围里']);
  });
});

/**
 * 澄清不能没完没了。
 *
 * 这一条是**实测出来的**：学生说「周三那两项挪到周末」，模型先问「是哪两项」，
 * 回答之后它又问「周六还是周日」——一直在问，一条提案都不给。
 * 提示词里写着「最多两轮」，但提示词没有约束力。
 */
describe('硬规则：澄清最多两轮，之后必须给东西', () => {
  const plan = planWith();

  it('没到上限时，问题照常给', () => {
    const r = resolveTalkOutput(out({ understanding: 'x', questions: [question()] }), plan, TODAY, { rounds: 1 });
    assert.equal(r.questions.length, 1);
  });

  it('到上限之后还要问 → 问题被砍掉', () => {
    const r = resolveTalkOutput(out({ understanding: 'x', questions: [question()] }), plan, TODAY, { rounds: 2 });
    assert.equal(r.questions.length, 0, '问到上限还在问，就是「一直问、什么都不做」');
    assert.equal(r.dropped, 1);
  });

  it('到上限时它只剩问题 → 必须说出来，不能显示一个空屏幕', () => {
    const r = resolveTalkOutput(out({ understanding: 'x', questions: [question()] }), plan, TODAY, { rounds: 2 });
    assert.equal(r.proposals.length, 0);
    assert.equal(r.refusals.length, 1);
    assert.match(r.refusals[0]!, /换句话|手动改/);
  });

  it('到上限时它给了提案 → 提案留着，问题砍掉', () => {
    const r = resolveTalkOutput(
      out({
        understanding: 'x',
        questions: [question()],
        proposals: [
          { kind: 'reschedule', taskId: 't_a', scheduledFor: '2026-10-10', reason: 'r', engineReason: 'r' },
        ],
      }),
      plan,
      TODAY,
      { rounds: 2 }
    );
    assert.equal(r.questions.length, 0);
    assert.equal(r.proposals.length, 1, '该给提案的那一轮，提案不能被牵连');
    assert.equal(r.refusals.length, 0);
  });

  it('clarifyRounds 数的是「AI 问过几轮」，不是问过几个问题', () => {
    const ai = (n: number) => ({ role: 'ai' as const, understanding: 'x', questions: [question(`q_${n}`)] });
    assert.equal(clarifyRounds([{ role: 'student', text: 'x' }]), 0);
    assert.equal(clarifyRounds([{ role: 'student', text: 'x' }, ai(1)]), 1);
    assert.equal(clarifyRounds([{ role: 'student', text: 'x' }, ai(1), answerTurn('p', 'a'), ai(2)]), 2);
    // 没问问题的 AI 轮不算
    assert.equal(clarifyRounds([{ role: 'ai', understanding: 'x', questions: [] }]), 0);
  });

  it('提示词里会告诉模型还剩几轮（不然它只会被砍成空屏幕）', () => {
    const base = { plan: 'x', today: TODAY, profile: null };
    const first = buildTalkMessages({ ...base, history: [{ role: 'student', text: '挪一下' }] });
    assert.match(first.user, /还可以澄清 2 轮/);
    const third = buildTalkMessages({
      ...base,
      history: [
        { role: 'student', text: 'a' },
        { role: 'ai', understanding: 'x', questions: [question('q_1')] },
        answerTurn('p', 'a'),
        { role: 'ai', understanding: 'x', questions: [question('q_2')] },
        answerTurn('p', 'a'),
      ],
    });
    assert.match(third.user, /不能再问/);
  });
});

describe('输入契约', () => {
  it('history 至少要有一轮（学生得先说话）', () => {
    assert.equal(TalkInput.safeParse({ plan: 'x', today: TODAY, history: [] }).success, false);
  });

  it('档案可以没有', () => {
    const r = TalkInput.safeParse({
      plan: 'x',
      today: TODAY,
      history: [{ role: 'student', text: '周三有事' }],
    });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.profile, null);
  });

  it('answerTurn 把回答压成一句学生口吻的话', () => {
    const t = answerTurn('周三还是周六？', '周六');
    assert.equal(t.role, 'student');
    assert.match(t.role === 'student' ? t.text : '', /周三还是周六？.*周六/);
  });

  it('轮次上限：超过就拒绝（省 token，也避免模型被长上下文带偏）', () => {
    const long = Array.from({ length: 20 }, () => ({ role: 'student' as const, text: 'x' }));
    assert.equal(TalkInput.safeParse({ plan: 'x', today: TODAY, history: long }).success, false);
  });
});

describe('提示词', () => {
  const plan = planWith();

  it('把计划原文、今天、以及对话都带上', () => {
    const { system, user } = buildTalkMessages({
      plan: 'schema: studyplan/v1\nid: plan_x\nversion: 1',
      today: TODAY,
      profile: { ...{ goalStatement: null, deadline: null, level: null, weeklyHours: 3, weekdays: [], weakSpots: [], blackouts: [] } },
      history: [{ role: 'student', text: '周三晚上有事' }],
    });
    assert.match(user, /2026-10-05/);
    assert.match(user, /周三晚上有事/);
    assert.match(user, /每周.*3|"weeklyHours":3/);
    assert.match(system, /不许自己编 id/);
    assert.match(system, /proposals 必须是空数组/);
    assert.match(system, /不要润色学生的原话/);
    void plan;
  });

  it('没有档案时也说得清楚，而不是留个空位', () => {
    const { user } = buildTalkMessages({
      plan: 'x',
      today: TODAY,
      profile: null,
      history: [{ role: 'student', text: '你好' }],
    });
    assert.match(user, /还没有/);
  });

  it('AI 那一轮会把「问了什么」也带上（否则下一轮不知道学生答的是哪题）', () => {
    const { user } = buildTalkMessages({
      plan: 'x',
      today: TODAY,
      profile: null,
      history: [
        { role: 'student', text: '挪一下' },
        { role: 'ai', understanding: '你想挪一项', questions: [question()] },
        answerTurn('周三还是周六？', '周六'),
      ],
    });
    assert.match(user, /你想挪一项/);
    assert.match(user, /周三还是周六/);
  });
});
