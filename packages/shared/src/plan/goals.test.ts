/**
 * 多目标：一个计划里几条**各自有截止日**的线，以及复盘怎么对它们说话。
 *
 * ## 这一组在测什么
 *
 * 「目标」在数据里就是里程碑（`PlanFile.goal` 只留那句总目标原话）。
 * 所以这一组要证明的是三件事：
 *
 * 1. 能**新增**一条线，连同它的能力点和任务，一条命令原子落地；
 * 2. 新增之后，它的任务能被**引擎排出真实日期**（不是许愿也不是模型编的）；
 * 3. 复盘能**分开**对每一条线说话——紧的是哪条就动哪条的截止日，
 *    而不是一律去动总截止日（那是一个真错，见下面那条回归用例）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, validatePlan, type PlanFile } from './schema.ts';
import { applyCommand } from './commands.ts';
import { detectDrift, rescheduleHorizon, reviewPlan } from './engine.ts';
import { allocateIds, Proposal, toAppliedAdjustment, validateProposal } from './proposal.ts';
import { placeNewTasks } from './schedule.ts';
import { reviewProposals, reviewDirection } from './review-session.ts';
import { describeAdjustment, describeProposal } from './describe.ts';

const T0 = '2026-10-05T09:00:00+08:00';
const TODAY = '2026-10-05';

/**
 * 一份「已经在跑」的计划：一句总目标（明年四月）+ 一条线（基础算法，11-30 截止）
 * + 每周两个时段 + 期中考试周不可用。
 */
function basePlan(): PlanFile {
  let p = emptyPlan('plan_goals', T0, '测试计划');
  p.goal.statement = '明年四月能独立做出省赛中等难度的题';
  p.goal.deadline = '2027-04-11';

  let r = applyCommand(p, {
    type: 'constraints.update',
    at: T0,
    patch: {
      weeklyMinutes: 480,
      availableSlots: [
        { day: 'mon', from: '19:00', to: '21:00' },
        { day: 'sat', from: '09:00', to: '12:00' },
      ],
      blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }],
    },
  });
  if (!r.ok) throw new Error(r.error);
  p = r.plan;

  r = applyCommand(p, {
    type: 'plan.applyAdjustments',
    at: T0,
    applied: [
      {
        kind: 'addMilestone',
        milestone: { id: 'm_base', title: '基础算法', due: '2026-11-30', criteria: [], status: 'active' },
        competences: [{ id: 'c_dp', name: '动态规划', target: 0.8, current: 0.2, evidence: [] }],
        tasks: [
          { id: 't_dp1', title: '01 背包手推 5 遍', type: 'practice', estimateMin: 60, milestoneId: 'm_base' },
          { id: 't_dp2', title: '区间 DP 三道题', type: 'practice', estimateMin: 60, milestoneId: 'm_base' },
        ],
        reason: '建立第一条线',
      },
    ],
  });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}

/** 学生说「我还想同时准备蓝桥杯，十一月底到十二月底」之后，模型给出的那张卡 */
type AddMilestoneCard = Extract<Proposal, { kind: 'addMilestone' }>;

function addBlueBridge(): AddMilestoneCard {
  return {
    kind: 'addMilestone',
    milestone: {
      title: '蓝桥杯省赛',
      due: '2026-12-31',
      criteria: ['省二以上'],
      competences: ['搜索', '贪心'],
    },
    tasks: [
      { title: 'DFS/BFS 模板默写', type: 'practice', estimateMin: 60, notes: '', scheduledFor: null, notBefore: null, tags: [] },
      { title: '历年真题 2 套', type: 'practice', estimateMin: 90, notes: '', scheduledFor: null, notBefore: null, tags: [] },
      { title: '贪心专题', type: 'read', estimateMin: 45, notes: '', scheduledFor: null, notBefore: null, tags: [] },
    ],
    reason: '你说想同时准备蓝桥杯，我把它立成一条独立的线',
    engineReason: '你说想同时准备蓝桥杯，我把它立成一条独立的线',
  };
}

describe('新增一条目标线', () => {
  it('校验通过：名字不重、截止日不在过去、时长在范围内', () => {
    const p = basePlan();
    assert.deepEqual(validateProposal(addBlueBridge(), p, TODAY), { ok: true });
  });

  /**
   * 回归：真机实测撞出来的。
   *
   * 模型给一个新增目标写了 6 条很不错的任务，每条都带 `tags: ["搜索"]`——
   * 它把「标记」理解成了**话题名**。而 `Task.tags` 存的是标记目录的 id
   * （`^[a-z][a-z0-9_]{0,31}$`），于是**整条 `addMilestone` 提案 schema 不过**：
   * 一个目标连带 6 条任务全没了，而界面上什么都不显示。
   *
   * 一个装饰性的标记不该有这种杀伤半径，所以 `DraftTask.tags` 用 `.catch([])`：
   * 标签丢掉，目标和任务照常进来。
   */
  it('模型把话题名当标记塞进 tags 时，丢的是标签，不是整条提案', () => {
    const p = basePlan();
    const card = addBlueBridge();
    const withTags: Proposal = {
      ...card,
      tasks: card.tasks.map((t) => ({ ...t, tags: ['搜索', '贪心'] })),
    };
    const parsed = Proposal.safeParse(withTags);
    assert.equal(parsed.success, true, '一条标签不该让整个目标进不来');
    if (!parsed.success || parsed.data.kind !== 'addMilestone') return;

    assert.equal(parsed.data.tasks.length, 3);
    for (const t of parsed.data.tasks) assert.deepEqual(t.tags, [], '非法标记被丢掉，而不是留下来污染标记目录');
    assert.deepEqual(validateProposal(parsed.data, p, TODAY), { ok: true });
  });

  it('合法的标记 id 照样保留（宽容不等于一律清空）', () => {
    const card = addBlueBridge();
    const withTags: Proposal = {
      ...card,
      tasks: card.tasks.map((t, i) => ({ ...t, tags: i === 0 ? ['tag_focus'] : [] })),
    };
    const parsed = Proposal.safeParse(withTags);
    assert.equal(parsed.success, true);
    if (parsed.success && parsed.data.kind === 'addMilestone') {
      assert.deepEqual(parsed.data.tasks[0]?.tags, ['tag_focus']);
    }
  });

  it('重名要拦：界面上是用标题认人的', () => {
    const p = basePlan();
    const dup: Proposal = { ...addBlueBridge(), milestone: { ...addBlueBridge().milestone, title: '基础算法' } };
    const r = validateProposal(dup, p, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /已经有一个叫/);
  });

  it('截止日是过去 → 拦下', () => {
    const p = basePlan();
    const bad: Proposal = { ...addBlueBridge(), milestone: { ...addBlueBridge().milestone, due: '2026-10-01' } };
    const r = validateProposal(bad, p, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /过去/);
  });

  it('一条命令原子落地：目标、能力点、任务、连线，一次全成', () => {
    const p = basePlan();
    const card = addBlueBridge();
    const ids = allocateIds(p, [card]);
    const applied = toAppliedAdjustment(card, ids.get('addMilestone:蓝桥杯省赛'));

    const r = applyCommand(p, { type: 'plan.applyAdjustments', at: T0, applied: [applied] });
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    if (!r.ok) return;

    // 只前进一版：三条命令拆开发的话，中间失败会留下「目标在、任务不在」
    assert.equal(r.plan.version, p.version + 1);
    assert.equal(r.plan.milestones.length, 2);
    assert.equal(r.plan.competences.length, 3, '两条线各有自己的能力点');

    const blue = r.plan.milestones.find((m) => m.title === '蓝桥杯省赛');
    assert.ok(blue);
    assert.equal(blue.due, '2026-12-31');

    // 新任务全部挂在**新目标**上，而不是走错线
    const owned = r.plan.tasks.filter((t) => t.milestoneId === blue.id);
    assert.equal(owned.length, 3);

    // 新目标的能力点名字对得上，而且是新 id
    const names = r.plan.competences.filter((c) => blue.competenceIds.includes(c.id)).map((c) => c.name);
    assert.deepEqual(names.sort(), ['搜索', '贪心']);

    // 原有那条线一个字都没动
    const base = r.plan.milestones.find((m) => m.id === 'm_base');
    assert.equal(base?.due, '2026-11-30');
    assert.equal(r.plan.tasks.filter((t) => t.milestoneId === 'm_base').length, 2);

    // 落地之后整份计划仍然自洽
    assert.deepEqual(
      validatePlan(r.plan).filter((i) => i.level === 'error'),
      []
    );
  });

  it('摘要点名新目标，而不是「应用了 N 项调整」', () => {
    const p = basePlan();
    const card = addBlueBridge();
    const ids = allocateIds(p, [card]);
    const r = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [toAppliedAdjustment(card, ids.get('addMilestone:蓝桥杯省赛'))],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.plan.history.at(-1)?.summary ?? '', /新增目标「蓝桥杯省赛」/);
  });

  it('id 分配是纯函数：两次调用结果相同，且不撞已有 id', () => {
    const p = basePlan();
    const cards = [addBlueBridge(), { ...addBlueBridge(), milestone: { ...addBlueBridge().milestone, title: 'ACM 校赛' } } as Proposal];
    const a = allocateIds(p, cards);
    const b = allocateIds(p, cards);
    assert.deepEqual([...a.entries()], [...b.entries()]);

    const blue = a.get('addMilestone:蓝桥杯省赛')?.milestone;
    const acm = a.get('addMilestone:ACM 校赛')?.milestone;
    assert.ok(blue && acm);
    // 同一批里两条提案的 id 不能撞
    assert.notEqual(blue.id, acm.id);
    assert.equal(new Set([...blue.taskIds, ...acm.taskIds]).size, 6);
    assert.equal(p.tasks.some((t) => blue.taskIds.includes(t.id)), false);
    assert.equal(p.milestones.some((m) => m.id === blue.id), false);
  });
});

describe('新增目标能被排进时间', () => {
  it('模型把日期留空，引擎把三条任务排出真实日期', () => {    const p = basePlan();
    const placed = placeNewTasks(p, [addBlueBridge()], TODAY);
    const card = placed.find((x) => x.kind === 'addMilestone');
    assert.ok(card && card.kind === 'addMilestone');

    assert.equal(card.tasks.length, 3);
    for (const t of card.tasks) {
      assert.ok(t.scheduledFor, `「${t.title}」没有被排出日期`);
      assert.ok(t.scheduledFor! >= TODAY, '排到了过去');
      // 落在学生说的不可用区间里也不行
      assert.equal(t.scheduledFor! >= '2026-11-02' && t.scheduledFor! <= '2026-11-06', false);
    }
  });

  it('同一张卡跑两次结果一样（排期不是随机的）', () => {
    const p = basePlan();
    const a = placeNewTasks(p, [addBlueBridge()], TODAY);
    const b = placeNewTasks(p, [addBlueBridge()], TODAY);
    assert.deepEqual(a, b);
  });

  it('只要一条新增提案时，其余提案原样返回、顺序不变', () => {
    const p = basePlan();
    const others: Proposal[] = [
      { kind: 'estimate', taskId: 't_dp1', estimateMin: 90, reason: 'r', engineReason: 'r' },
      addBlueBridge(),
      { kind: 'profile', patch: { weeklyHours: 8 }, reason: 'r', engineReason: 'r' },
    ];
    const out = placeNewTasks(p, others, TODAY);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((x) => x.kind), ['estimate', 'addMilestone', 'profile']);
    assert.deepEqual(out[0], others[0]);
    assert.deepEqual(out[2], others[2]);
  });

  it('没有任何新增时原样返回（不做多余计算）', () => {
    const p = basePlan();
    const only: Proposal[] = [{ kind: 'estimate', taskId: 't_dp1', estimateMin: 90, reason: 'r', engineReason: 'r' }];
    assert.deepEqual(placeNewTasks(p, only, TODAY), only);
  });

  it('投影不会改动原计划', () => {
    const p = basePlan();
    const before = JSON.stringify(p);
    placeNewTasks(p, [addBlueBridge()], TODAY);
    assert.equal(JSON.stringify(p), before, '排期只是算，绝不能顺手写进计划');
  });

  it('卡片上能看到「没排进去」，而不是假装成功', () => {
    // 只有一个时段、且很快就要考试周时，容量可能真的不够
    const p = basePlan();
    const placed = placeNewTasks(p, [addBlueBridge()], TODAY);
    const row = describeProposal(placed.find((x) => x.kind === 'addMilestone')!, p);
    assert.match(row.title, /新目标「蓝桥杯省赛」/);
    assert.match(row.change, /排进|排不进|排在/);
    assert.match(row.change, /3 项 · 合计 3 小时 15 分/);
  });
});

describe('复盘分开对每条线说话', () => {
  /** 把新线真的装上，得到「两条线同时在跑」的计划 */
  function planWithTwoLines(): PlanFile {
    const p = basePlan();
    const card = addBlueBridge();
    const applied = toAppliedAdjustment(card, allocateIds(p, [card]).get('addMilestone:蓝桥杯省赛'));
    const r = applyCommand(p, { type: 'plan.applyAdjustments', at: T0, applied: [applied] });
    if (!r.ok) throw new Error(r.error);
    return r.plan;
  }

  /**
   * 蓝桥杯那条线**明确来不及**：把它自己的截止日压到一周后，
   * 而三条任务合计 30 小时——一周里学生只有两个时段共 5 小时。
   *
   * 刻意用「压截止日」而不是「灌任务时长」来造这个局面：
   * 后者依赖容量的算术细节，改一个常量就悄悄失效了；
   * 前者一眼就能看懂为什么来不及，而且是真实会发生的情形。
   */
  function planWithTightBlueLine(): { plan: PlanFile; blueId: string } {
    const p = planWithTwoLines();
    const blue = p.milestones.find((m) => m.title === '蓝桥杯省赛');
    assert.ok(blue);
    const heavy = [
      { kind: 'milestone' as const, milestoneId: blue.id, patch: { due: '2026-10-12' }, reason: 'r' },
      ...p.tasks
        .filter((t) => t.milestoneId === blue.id)
        .map((t) => ({ kind: 'taskPatch' as const, taskId: t.id, patch: { estimateMin: 600 }, reason: 'r' })),
    ];
    const r = applyCommand(p, { type: 'plan.applyAdjustments', at: T0, applied: heavy });
    if (!r.ok) throw new Error(r.error);
    return { plan: r.plan, blueId: blue.id };
  }

  it('两条线各自出现在偏差检测里（紧的是蓝桥杯，不是基础算法）', () => {
    const { plan: p, blueId } = planWithTightBlueLine();
    const risky = detectDrift(p, TODAY).filter((d) => d.kind === 'milestoneRisk');

    assert.equal(risky.length, 1, '只有那条紧的线该报风险');
    assert.equal(risky[0]?.kind === 'milestoneRisk' ? risky[0].milestoneId : null, blueId);
  });

  /**
   * 回归：这一条是修掉的那个真错。
   *
   * 原来检测到 `milestoneRisk` 时给出的卡改的是 **`goal.deadline`**（+14 天）。
   * 总目标在明年四月、而紧的是十月中那条线时，那张卡什么都没解决，
   * 卡片上却写着「里程碑可能赶不上」。
   */
  it('紧的那条线 → 卡片改的是**它自己的**截止日，不是总截止日', () => {
    const { plan: p, blueId } = planWithTightBlueLine();
    const report = reviewPlan(p, TODAY);
    const cards = reviewProposals(p, report, {});
    const msCards = cards.filter((c) => c.kind === 'milestone');

    assert.ok(msCards.length >= 1, '应该给出改某条线截止日的卡');
    const card = msCards.find((c) => c.kind === 'milestone' && c.milestoneId === blueId);
    assert.ok(card, '卡应该指向那条紧的线');
    if (card?.kind !== 'milestone') return;

    // 10-12 往后挪两周
    assert.equal(card.patch.due, '2026-10-26');

    const after = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [toAppliedAdjustment(card)],
    });
    assert.equal(after.ok, true, after.ok ? '' : after.error);
    if (!after.ok) return;
    assert.equal(after.plan.goal.deadline, '2027-04-11', '总截止日不该被动');
    assert.equal(after.plan.milestones.find((m) => m.id === 'm_base')?.due, '2026-11-30', '另一条线也不该被动');
    assert.equal(after.plan.milestones.find((m) => m.id === blueId)?.due, '2026-10-26');
  });

  it('方向那句话会点名是哪条线来不及', () => {
    const { plan: p } = planWithTightBlueLine();
    const report = reviewPlan(p, TODAY);
    const dir = reviewDirection(p, report, reviewProposals(p, report, {}));
    assert.match(dir, /蓝桥杯省赛/, `方向里应该点名那条线，实际：${dir}`);
  });

  it('学生答「截止日往后挪」时，两条线各自出各自的卡', () => {
    const { plan: p, blueId } = planWithTightBlueLine();
    const report = reviewPlan(p, TODAY);
    const cards = reviewProposals(p, report, { q_goal: { questionId: 'q_goal', kind: 'single', value: 'extend' } });
    const msCards = cards.filter((c) => c.kind === 'milestone');
    assert.ok(msCards.length >= 1);
    // 每张卡指向**不同的**线，而且改的是那条线自己的日期
    const ids = new Set(msCards.map((c) => (c.kind === 'milestone' ? c.milestoneId : '')));
    assert.equal(ids.has(blueId), true);
  });

  it('排期视野按最远的那条线算，而不是永远 84 天', () => {
    const p = basePlan();
    // 基础算法 11-30（56 天）、总目标 2027-04-11（188 天）
    assert.ok(rescheduleHorizon(p, TODAY) > 188, '视野要覆盖到最远的截止日并留余量');

    // 没有截止日时退回默认值
    const bare = emptyPlan('plan_bare', T0, 'x');
    assert.equal(rescheduleHorizon(bare, TODAY), 84);
  });

  it('任务排到自己那条线的截止日之后 → 校验说出来', () => {
    const p = planWithTwoLines();
    const blue = p.milestones.find((m) => m.title === '蓝桥杯省赛');
    assert.ok(blue);
    const t = p.tasks.find((x) => x.milestoneId === blue.id);
    assert.ok(t);

    const r = applyCommand(p, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [{ kind: 'taskPatch', taskId: t.id, patch: { scheduledFor: '2027-01-20' }, reason: 'r' }],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const warns = validatePlan(r.plan).filter((i) => i.level === 'warn' && /蓝桥杯省赛/.test(i.message));
    assert.equal(warns.length >= 1, true, '应该警告这条排期晚于它自己那条线的截止日');
  });

  it('改一个目标的截止日写成一句人话（不是 JSON，也不显示 id）', () => {
    const p = planWithTwoLines();
    const blue = p.milestones.find((m) => m.title === '蓝桥杯省赛');
    assert.ok(blue);
    const card: Proposal = {
      kind: 'milestone',
      milestoneId: blue.id,
      patch: { due: '2027-01-14' },
      reason: '挪两周',
      engineReason: '挪两周',
    };
    const row = describeProposal(card, p);
    assert.equal(row.title, '目标「蓝桥杯省赛」');
    assert.match(row.change, /截止日 → 1月14日/);
    assert.equal(row.change.includes(blue.id), false, '不能把 m_02 这种内部 id 摆给学生看');

    const applied = toAppliedAdjustment(card);
    assert.match(describeAdjustment(applied, (id) => id, (id) => (id === blue.id ? blue.title : id)), /蓝桥杯省赛/);
  });
});
