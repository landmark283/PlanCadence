/**
 * interview 契约的测试。
 *
 * 其中「题库自身必须满足契约」这一组不是形式主义——它本来能挡住一个真实缺陷：
 * 最初 `q_weak` 写成了 `kind: 'multi'` 却没给 `options`，
 * 于是前端渲染出一个没有任何选项的空控件，学生只能干瞪眼。
 * 类型检查看不出这种错（`options` 有默认值 `[]`），跑起来才看得见。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAnswer,
  describeProfile,
  emptyProfile,
  InterviewOutput,
  LearnerProfile,
  MAX_QUESTIONS,
  missingProfileFields,
  nextLocalQuestion,
  QUESTION_BANK,
  QuestionSpec,
  validateInterviewQuestion,
} from './interview.ts';

describe('本地题库必须自身满足题目契约', () => {
  it('每道题都带 why——它是「这题会影响哪个排期决策」的说明', () => {
    for (const q of QUESTION_BANK) {
      assert.ok(q.why.length > 0, `${q.id} 缺少 why`);
    }
  });

  it('id 不重复', () => {
    const ids = QUESTION_BANK.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.join(',')}`);
  });

  it('单选/多选题至少有 2 个选项——否则渲染出来是个空控件', () => {
    for (const q of QUESTION_BANK) {
      if (q.kind === 'single' || q.kind === 'multi') {
        assert.ok(q.options.length >= 2, `${q.id} 是 ${q.kind} 却只有 ${q.options.length} 个选项`);
      }
    }
  });

  it('scale 题必须有 min < max', () => {
    for (const q of QUESTION_BANK) {
      if (q.kind === 'scale') {
        assert.ok(q.min !== null && q.max !== null && q.max > q.min, `${q.id} 的区间不合法`);
      }
    }
  });

  it('题目数量不超过上限', () => {
    assert.ok(QUESTION_BANK.length <= MAX_QUESTIONS, `题库有 ${QUESTION_BANK.length} 题，上限是 ${MAX_QUESTIONS}`);
  });

  it('都能通过 zod 解析（默认值补齐后仍然合法）', () => {
    for (const q of QUESTION_BANK) {
      const r = QuestionSpec.safeParse(q);
      assert.equal(r.success, true, `${q.id} 解析失败`);
    }
  });
});

describe('nextLocalQuestion：确定性兜底', () => {
  it('按顺序出题，且不重复', () => {
    const asked: QuestionSpec[] = [];
    const seen = new Set<string>();
    for (;;) {
      const q = nextLocalQuestion(asked);
      if (!q) break;
      assert.ok(!seen.has(q.id), `重复出题 ${q.id}`);
      seen.add(q.id);
      asked.push(q);
      assert.ok(asked.length <= MAX_QUESTIONS + 1, '出题没有终止');
    }
    assert.equal(asked.length, Math.min(QUESTION_BANK.length, MAX_QUESTIONS));
  });

  it('问完就返回 null（调用方据此结束访谈）', () => {
    assert.equal(nextLocalQuestion(QUESTION_BANK), null);
  });
});

describe('applyAnswer：作答进档案', () => {
  const byId = (id: string) => {
    const q = QUESTION_BANK.find((x) => x.id === id);
    assert.ok(q, `题库里没有 ${id}`);
    return q;
  };

  it('文本题写进对应字段，且去掉首尾空白', () => {
    const p = applyAnswer(emptyProfile(), byId('q_goal'), {
      questionId: 'q_goal',
      kind: 'text',
      value: '  把 DP 练到能独立写出来  ',
    });
    assert.equal(p.goalStatement, '把 DP 练到能独立写出来');
  });

  it('只写空白等于没答，存 null 而不是空串', () => {
    const p = applyAnswer(emptyProfile(), byId('q_goal'), { questionId: 'q_goal', kind: 'text', value: '   ' });
    assert.equal(p.goalStatement, null);
  });

  it('日期题存字符串，清空存 null', () => {
    const q = byId('q_deadline');
    assert.equal(applyAnswer(emptyProfile(), q, { questionId: 'q_deadline', kind: 'date', value: '2027-04-11' }).deadline, '2027-04-11');
    assert.equal(applyAnswer(emptyProfile(), q, { questionId: 'q_deadline', kind: 'date', value: null }).deadline, null);
  });

  it('多选题整批覆盖，不累加（回到上一题改答案必须能改小）', () => {
    const q = byId('q_weekdays');
    const once = applyAnswer(emptyProfile(), q, { questionId: 'q_weekdays', kind: 'multi', values: ['mon', 'wed'] });
    assert.deepEqual(once.weekdays, ['mon', 'wed']);
    const twice = applyAnswer(once, q, { questionId: 'q_weekdays', kind: 'multi', values: ['sat'] });
    assert.deepEqual(twice.weekdays, ['sat'], '改答案应当覆盖而不是累加');
  });

  it('questionId 对不上时原样返回，不会把答案写到别的字段上', () => {
    const before = emptyProfile();
    const after = applyAnswer(before, byId('q_goal'), { questionId: 'q_weekly', kind: 'scale', value: 9 });
    assert.deepEqual(after, before);
  });
});

describe('档案完整度', () => {
  it('空档案列出全部 5 项缺失', () => {
    assert.equal(missingProfileFields(emptyProfile()).length, 5);
  });

  it('答完关键题后不再报缺——学生跳过也照样能往下走', () => {
    let p = emptyProfile();
    p = applyAnswer(p, QUESTION_BANK[0], { questionId: 'q_goal', kind: 'text', value: '做出省赛中等题' });
    p = applyAnswer(p, QUESTION_BANK[1], { questionId: 'q_deadline', kind: 'date', value: '2027-04-11' });
    p = applyAnswer(p, QUESTION_BANK[2], { questionId: 'q_level', kind: 'single', value: 'intermediate' });
    p = applyAnswer(p, QUESTION_BANK[3], { questionId: 'q_weekly', kind: 'scale', value: 9 });
    p = applyAnswer(p, QUESTION_BANK[4], { questionId: 'q_weekdays', kind: 'multi', values: ['mon', 'wed', 'sat'] });
    assert.deepEqual(missingProfileFields(p), []);
  });

  it('摘要里出现的是人话，不是枚举值', () => {
    const p = applyAnswer(emptyProfile(), QUESTION_BANK[2], { questionId: 'q_level', kind: 'single', value: 'intermediate' });
    const s = describeProfile(p);
    assert.match(s, /能做简单题/);
    assert.doesNotMatch(s, /intermediate/);
  });
});

describe('validateInterviewQuestion：模型出的题要过筛', () => {
  const good = {
    id: 'q_extra',
    kind: 'single' as const,
    prompt: '你平时用什么语言？',
    why: '语言会影响题单的选择。',
    options: [
      { value: 'cpp', label: 'C++' },
      { value: 'py', label: 'Python' },
    ],
    min: null,
    max: null,
    step: null,
    unit: null,
    placeholder: null,
    suggestions: [],
  };
  const wrap = (question: unknown) => InterviewOutput.parse({ done: false, question });

  it('合格的题通过', () => {
    assert.ok(validateInterviewQuestion(wrap(good), emptyProfile(), []));
  });

  it('done=true 时不再出题', () => {
    assert.equal(validateInterviewQuestion(InterviewOutput.parse({ done: true }), emptyProfile(), []), null);
  });

  it('重复 id 被丢弃', () => {
    const asked = [QUESTION_BANK[0]];
    assert.equal(validateInterviewQuestion(wrap({ ...good, id: 'q_goal' }), emptyProfile(), asked), null);
  });

  it('只有 1 个选项的单选被丢弃（这是渲染不出东西的空壳）', () => {
    assert.equal(validateInterviewQuestion(wrap({ ...good, options: [{ value: 'a', label: 'A' }] }), emptyProfile(), []), null);
  });

  it('区间不合法的 scale 被丢弃', () => {
    const bad = { ...good, kind: 'scale', options: [], min: 10, max: 2 };
    assert.equal(validateInterviewQuestion(wrap(bad), emptyProfile(), []), null);
  });

  it('已经答过的关键信息不会再问一遍', () => {
    const p = applyAnswer(emptyProfile(), QUESTION_BANK[0], { questionId: 'q_goal', kind: 'text', value: '已答' });
    assert.equal(validateInterviewQuestion(wrap({ ...good, field: 'goalStatement' }), p, []), null);
  });

  it('换了个 id、但 field 相同的题，也不会重问', () => {
    const p = applyAnswer(emptyProfile(), QUESTION_BANK[0], { questionId: 'q_goal', kind: 'text', value: '已答' });
    const renamed = { ...good, id: 'q_whatever_new', field: 'goalStatement' as const };
    assert.equal(validateInterviewQuestion(wrap(renamed), p, []), null, '按 field 判重，不能靠 id');
  });

  it('field 与 kind 不匹配的题被丢弃——那题的答案根本写不进档案', () => {
    // goalStatement 只接受 text，模型却给了 single
    const mismatched = { ...good, id: 'q_bad_kind', field: 'goalStatement' as const, kind: 'single' as const };
    assert.equal(validateInterviewQuestion(wrap(mismatched), emptyProfile(), []), null);
  });

  it('field 为 null 的题允许问，只是答案不落档案', () => {
    assert.ok(validateInterviewQuestion(wrap({ ...good, field: null }), emptyProfile(), []));
  });

  it('已经问满上限后不再出题', () => {
    const asked = Array.from({ length: MAX_QUESTIONS }, (_, i) => ({ ...QUESTION_BANK[0], id: `q_filler_${i}` }));
    assert.equal(validateInterviewQuestion(wrap(good), emptyProfile(), asked), null);
  });
});

describe('作答按 field 落档案（而不是靠题目 id 巧合）', () => {
  /**
   * 这一组是两条真实事故的回归测试。
   *
   * 事故一：`applyAnswer` 原来只认我们自己定的 id（`q_goal` / `q_weekdays`…）。
   * 模型出的题 id 是 `q_dp_focus` 之类，于是**答案一条都写不进档案**，
   * 访谈全程白做，而且没有任何报错——只是最后生成出一份通用计划。
   */
  it('id 完全不同的题，只要 field 对，答案照样写进档案', () => {
    const q = QuestionSpec.parse({ id: 'q_model_invented', field: 'goalStatement', kind: 'text', prompt: 'x', why: 'y' });
    const p = applyAnswer(emptyProfile(), q, { questionId: 'q_model_invented', kind: 'text', value: '把 DP 练出来' });
    assert.equal(p.goalStatement, '把 DP 练出来');
  });

  /**
   * 事故二：模型若碰巧用了 `q_weekdays` 这个 id、但选项值是「工作日」，
   * 就会被写进一个非法的 weekday，档案随即非法，
   * 之后**每一个**请求都因为 profile 过不了 zod 而 400——访谈当场死掉。
   */
  it('weekdays 收到非枚举值时不会污染档案', () => {
    const q = QuestionSpec.parse({
      id: 'q_weekdays',
      field: 'weekdays',
      kind: 'multi',
      prompt: '哪几天方便？',
      why: '排期要用',
      options: [
        { value: '工作日', label: '工作日' },
        { value: '周末', label: '周末' },
        { value: 'wed', label: '周三' },
      ],
    });
    const p = applyAnswer(emptyProfile(), q, { questionId: 'q_weekdays', kind: 'multi', values: ['工作日', 'wed'] });
    assert.deepEqual(p.weekdays, ['wed'], '只留下合法的枚举值');
    assert.equal(LearnerProfile.safeParse(p).success, true, '档案必须仍然合法');
  });

  it('weeklyHours 超出 schema 上界时整条丢弃，而不是写进非法值', () => {
    const q = QuestionSpec.parse({
      id: 'q_weekly',
      field: 'weeklyHours',
      kind: 'scale',
      prompt: '每周多少小时？',
      why: '排期要用',
      min: 0,
      max: 100,
    });
    const p = applyAnswer(emptyProfile(), q, { questionId: 'q_weekly', kind: 'scale', value: 99 });
    assert.equal(p.weeklyHours, null, '99 小时过不了 schema，宁可不要这条信息');
    assert.equal(LearnerProfile.safeParse(p).success, true);
  });

  it('文本过长时整条丢弃，不让档案变得非法', () => {
    const q = QuestionSpec.parse({ id: 'q_goal', field: 'goalStatement', kind: 'text', prompt: 'x', why: 'y' });
    const p = applyAnswer(emptyProfile(), q, { questionId: 'q_goal', kind: 'text', value: '啊'.repeat(500) });
    assert.equal(p.goalStatement, null);
    assert.equal(LearnerProfile.safeParse(p).success, true);
  });

  it('本地题库每一题都声明了 field，且 kind 与之匹配', () => {
    for (const q of QUESTION_BANK) {
      assert.ok(q.field !== null, `${q.id} 没声明 field，答案会写不进档案`);
      const r = QuestionSpec.safeParse(q);
      assert.equal(r.success, true);
      if (r.success && r.data.field) {
        assert.equal(
          validateInterviewQuestion(
            { done: false, question: r.data },
            emptyProfile(),
            [],
          ) !== null,
          true,
          `${q.id} 的 field 与 kind 不匹配`,
        );
      }
    }
  });
});
