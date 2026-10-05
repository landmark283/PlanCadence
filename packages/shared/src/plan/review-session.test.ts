/**
 * 复盘会话的测试。
 *
 * 两条最重要的性质：
 *  1. **没有问题就不问**——一个每周都问三个问题的系统会被直接跳过；
 *  2. **生成的每一张卡都过得了自己的校验**——否则界面上会出现一张
 *     「点了就报错」的卡，而那是这一屏最伤的失败方式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, type PlanFile, type TaskInput } from './schema.ts';
import { applyCommand } from './commands.ts';
import { reviewPlan } from './engine.ts';
import { validateProposal } from './proposal.ts';
import {
  MAX_REVIEW_QUESTIONS,
  Q_OVERRUN,
  Q_REASON,
  REASON_TIME,
  REASON_UNWILLING,
  reviewDirection,
  reviewProposals,
  reviewQuestions,
} from './review-session.ts';
import type { Answer } from '../llm/interview.ts';

const T0 = '2026-10-05T09:00:00+08:00';
const TODAY = '2026-10-05';

function build(tasks: TaskInput[]): PlanFile {
  let p = emptyPlan('plan_rev', T0, '测试计划');
  for (const t of tasks) {
    const r = applyCommand(p, { type: 'task.add', at: T0, task: t });
    if (!r.ok) throw new Error(r.error);
    p = r.plan;
  }
  return p;
}

const single = (questionId: string, value: string): Answer => ({ questionId, kind: 'single', value });

/** 排在今天、就绪的一项：不产生任何偏差 */
const clean = () =>
  build([{ id: 't_ok', title: '正常的一项', estimateMin: 45, type: 'read', scheduledFor: TODAY }]);

/** 过期没做的一项 */
const overdue = (days = 6) => {
  const day = `2026-09-${String(30 - days).padStart(2, '0')}`;
  return build([{ id: 't_late', title: '落后的一项', estimateMin: 45, type: 'read', scheduledFor: day }]);
};

/** 做完但耗时远超预估的一项 */
const overrun = () =>
  build([
    {
      id: 't_slow',
      title: '很费劲的一项',
      estimateMin: 45,
      type: 'practice',
      scheduledFor: TODAY,
      actualMin: 120,
      status: 'done',
    },
  ]);

/** 做完但比预期快得多的一项 */
const underrun = () =>
  build([
    {
      id: 't_fast',
      title: '很快就做完的一项',
      estimateMin: 90,
      type: 'practice',
      scheduledFor: TODAY,
      actualMin: 25,
      status: 'done',
    },
  ]);

describe('问什么：只在答案会改变建议的时候问', () => {
  it('这周什么都没发生 → 一个问题都不问', () => {
    const p = clean();
    assert.deepEqual(reviewQuestions(p, reviewPlan(p, TODAY)), []);
  });

  it('有落后 → 问「主要是因为」', () => {
    const p = overdue();
    const qs = reviewQuestions(p, reviewPlan(p, TODAY));
    assert.equal(qs[0]?.id, Q_REASON);
    // 每题都必须有 why：它说明这题对应哪个决定
    assert.ok(qs[0]!.why.length > 0);
    assert.equal(qs[0]!.kind, 'single');
  });

  it('有超预估 → 问「估错了还是特别费劲」', () => {
    const p = overrun();
    const qs = reviewQuestions(p, reviewPlan(p, TODAY));
    assert.ok(qs.some((q) => q.id === Q_OVERRUN), `实际问了：${qs.map((q) => q.id).join(',')}`);
  });

  it('最多问两个', () => {
    const p = overrun();
    assert.ok(reviewQuestions(p, reviewPlan(p, TODAY)).length <= MAX_REVIEW_QUESTIONS);
  });
});

describe('给哪些卡：按需要给候选，而不是一条 drift 一条', () => {
  it('没有任何问题、也没有偏差 → 不给卡', () => {
    const p = clean();
    const report = reviewPlan(p, TODAY);
    assert.deepEqual(reviewProposals(p, report), []);
  });

  it('耗时超预估 → 给一张「把预估调上去」', () => {
    const p = overrun();
    const report = reviewPlan(p, TODAY);
    const out = reviewProposals(p, report);
    const est = out.find((x) => x.kind === 'estimate');
    assert.ok(est, '应该给一张调时长的卡');
    if (est?.kind !== 'estimate') return;
    assert.ok(est.estimateMin >= 120, `目标时长应至少覆盖实际用时，实际给了 ${est.estimateMin}`);
    assert.equal(est.estimateMin % 15, 0, '时长应该是 15 分钟的整倍数');
    assert.match(est.engineReason, /1\.8 倍|2\.6|倍/);
  });

  it('学生答「时间不够」→ 不给「把时长调上去」的卡', () => {
    const p = overrun();
    const report = reviewPlan(p, TODAY);
    const out = reviewProposals(p, report, { [Q_REASON]: single(Q_REASON, REASON_TIME) });
    assert.equal(out.some((x) => x.kind === 'estimate'), false, '时间不够还往上调时长只会更排不下');
  });

  it('学生答「就是不想做」→ 不给改期卡，改成放回待排池', () => {
    const p = overdue();
    const report = reviewPlan(p, TODAY);
    const out = reviewProposals(p, report, { [Q_REASON]: single(Q_REASON, REASON_UNWILLING) });
    const moves = out.filter((x) => x.kind === 'reschedule');
    assert.ok(moves.length > 0);
    for (const m of moves) {
      assert.equal(m.kind === 'reschedule' ? m.scheduledFor : 'x', null, '不想做就不该换个日子继续追');
    }
  });

  it('学得比预期快 → 给一张「加练」（标题是模板，学生改几个字就能用）', () => {
    const p = underrun();
    const report = reviewPlan(p, TODAY);
    const out = reviewProposals(p, report);
    const added = out.find((x) => x.kind === 'addTask');
    assert.ok(added, '应该给一张加练卡');
    if (added?.kind !== 'addTask') return;
    assert.match(added.task.title, /^加练：/);
    assert.equal(added.task.scheduledFor, null, '新卡不替学生决定排哪天');
  });

  it('拖过两周以上才提议「不做了」', () => {
    const fresh = overdue(2);
    const old = overdue(20);
    const freshOut = reviewProposals(fresh, reviewPlan(fresh, TODAY));
    const oldOut = reviewProposals(old, reviewPlan(old, TODAY));
    assert.equal(freshOut.some((x) => x.kind === 'dropTask'), false, '才两天就劝人放弃太急了');
    assert.equal(oldOut.some((x) => x.kind === 'dropTask'), true);
  });

  it('同一个任务不会出现两张一模一样的卡', () => {
    const p = overrun();
    const out = reviewProposals(p, reviewPlan(p, TODAY));
    const keys = out.map((x) => (x.kind === 'addTask' ? `addTask:${x.task.title}` : `${x.kind}:${'taskId' in x ? x.taskId : ''}`));
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('生成的每一张卡都必须过得了自己的校验', () => {
  // 这是整组里最重要的一条：卡片是拿来点的，点了报错比不给卡更糟
  const cases: [string, PlanFile][] = [
    ['干净的计划', clean()],
    ['有落后的', overdue()],
    ['拖了很久的', overdue(20)],
    ['超预估的', overrun()],
    ['学得快的', underrun()],
  ];

  for (const [name, plan] of cases) {
    it(`${name}：全部通过`, () => {
      const report = reviewPlan(plan, TODAY);
      for (const p of reviewProposals(plan, report)) {
        const r = validateProposal(p, plan, TODAY);
        assert.equal(r.ok, true, `${p.kind} 没过校验：${r.ok ? '' : r.reason}`);
      }
    });
  }

  it('引擎给出了过去的日期时，那张卡被丢掉而不是显示出来', () => {
    /**
     * 这条来自一个真 bug：复盘会话如果拿到**过期的「今天」**
     * （启动时时钟还没接上，用的是设备日期），引擎会按那个日期算排期，
     * 于是卡片上出现相对真实今天已经过去的日期——实测那时写着「→ 10/14」，
     * 而真实今天是 10/19。
     *
     * 根因是会话必须在时钟接上之后再开；这里是**第二道防线**：
     * 过不了校验的卡一张都不许出现。
     */
    const p = build([
      { id: 't_a', title: '会被排到过去的一项', estimateMin: 45, type: 'read', scheduledFor: '2026-10-21' },
    ]);
    const report = reviewPlan(p, TODAY);
    // 手工伪造一条「排到过去」的引擎调整
    const broken: typeof report = {
      ...report,
      adjustments: [{ kind: 'reschedule', taskId: 't_a', scheduledFor: '2026-09-01', reason: '伪造的' }],
    };
    const out = reviewProposals(p, broken);
    assert.equal(out.some((x) => x.kind === 'reschedule'), false, '排到过去的卡必须被丢掉');
  });

  it('答了问之后生成的卡同样都通过', () => {
    const p = overdue(20);
    const report = reviewPlan(p, TODAY);
    for (const answer of [REASON_TIME, REASON_UNWILLING, 'busy', 'hard']) {
      for (const proposal of reviewProposals(p, report, { [Q_REASON]: single(Q_REASON, answer) })) {
        const r = validateProposal(proposal, p, TODAY);
        assert.equal(r.ok, true, `答「${answer}」之后的 ${proposal.kind} 没过校验`);
      }
    }
  });
});

describe('方向那句话：本机保底版本永远有', () => {
  it('没问题时说的是「按现在的节奏继续」', () => {
    const p = clean();
    const text = reviewDirection(p, reviewPlan(p, TODAY), []);
    assert.match(text, /继续/);
  });

  it('有卡时说的是「下周」要动什么', () => {
    const p = overrun();
    const report = reviewPlan(p, TODAY);
    const text = reviewDirection(p, report, reviewProposals(p, report));
    assert.match(text, /下周/);
    assert.ok(text.length > 0);
  });
});
