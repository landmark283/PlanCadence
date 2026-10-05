/**
 * 学生档案的测试。
 *
 * 这一层要证明的其实只有一句话：**档案真的住在文件里**。
 * 也就是说它要能熬过一次「序列化 → 落盘 → 读回来 → 解析」的完整往返，
 * 而不是只在内存里活到下一次重启。
 *
 * 另一半同样重要：**坏档案不许把文件搞坏**。
 * 档案在 schema 里是宽松的 `unknown`，所以它可以是任何东西；一份结构不对的档案
 * 最坏只该退化成「它忘了你说过的话」，绝不该升级成「文件读不出来」，
 * 那会把学生自己写的任务一起锁在门外。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, type PlanFile } from './schema.ts';
import { parsePlan, serializePlan } from './io.ts';
import { readProfile, withProfile } from './profile.ts';
import { applyCommand } from './commands.ts';
import type { LearnerProfile } from '../llm/interview.ts';

const T0 = '2026-10-05T09:00:00+08:00';

const planWithNothing = () => emptyPlan('plan_profile', T0, '测试计划');

/** 一份「学生真的说过话」的档案：每个字段都非默认，免得默认值把断言蒙过去 */
const FULL: LearnerProfile = {
  goalStatement: '打进华北五省现场赛',
  deadline: '2026-11-20',
  level: 'basic',
  weeklyHours: 9,
  weekdays: ['tue', 'thu', 'sat'],
  weakSpots: ['图论', '动态规划'],
  blackouts: [{ from: '2026-11-01', to: '2026-11-03', reason: '期中考试' }],
};

describe('档案随文件往返', () => {
  it('写进去的档案，序列化再解析之后原样读得回来', () => {
    const text = serializePlan(withProfile(planWithNothing(), FULL));

    const parsed = parsePlan(text);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;

    assert.deepEqual(readProfile(parsed.plan), FULL);
  });

  it('往返之后档案里的每个字段都还在（不是只剩下默认值）', () => {
    const parsed = parsePlan(serializePlan(withProfile(planWithNothing(), FULL)));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const p = readProfile(parsed.plan);
    assert.ok(p);
    // 逐格断言：deepEqual 失败时只会说「对象不一样」，而这些字段各自都会影响排期
    assert.equal(p.goalStatement, '打进华北五省现场赛');
    assert.equal(p.deadline, '2026-11-20');
    assert.equal(p.level, 'basic');
    assert.equal(p.weeklyHours, 9);
    assert.deepEqual(p.weekdays, ['tue', 'thu', 'sat']);
    assert.deepEqual(p.weakSpots, ['图论', '动态规划']);
    assert.equal(p.blackouts.length, 1);
    assert.equal(p.blackouts[0]?.to, '2026-11-03');
  });

  it('老文件（没有 profile 段）读出来是 null，而且仍然是一份能用的文件', () => {
    // 造一份「上一版格式」的文件：把 profile 那一行删掉
    const withoutProfile = serializePlan(planWithNothing())
      .split('\n')
      .filter((line) => !line.startsWith('profile:'))
      .join('\n');

    const parsed = parsePlan(withoutProfile);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(readProfile(parsed.plan), null);
    assert.equal(parsed.plan.version, 1);
    assert.equal(parsed.plan.tasks.length, 0);
  });
});

describe('坏档案不连累文件', () => {
  it('结构不对的档案退化成 null，文件本身照旧读得出来', () => {
    const parsed = parsePlan(serializePlan({ ...planWithNothing(), profile: { weeklyHours: '很多' } }));
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
    if (!parsed.ok) return;
    assert.equal(readProfile(parsed.plan), null);
  });

  it('档案不是对象（被手改成字符串 / 数字 / 数组）也只算没有', () => {
    for (const junk of ['忘了', 42, [1, 2, 3], true]) {
      const parsed = parsePlan(serializePlan({ ...planWithNothing(), profile: junk }));
      assert.equal(parsed.ok, true, `${String(junk)} 不该让文件读不出来`);
      if (parsed.ok) assert.equal(readProfile(parsed.plan), null);
    }
  });

  it('有一格越界就整份当没有——不带着悄悄截断的档案去排计划', () => {
    // weakSpots 上限 8 条。宁可退化成「它忘了」，也不要拿着一个被截掉一半的
    // 档案去生成计划：那样学生看到的「薄弱点」和他说过的话对不上，还查不出来。
    const tooMany = { ...FULL, weakSpots: Array.from({ length: 9 }, (_, i) => `薄弱 ${i}`) };
    const parsed = parsePlan(serializePlan({ ...planWithNothing(), profile: tooMany }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(readProfile(parsed.plan), null);
  });

  it('null 与「没有」是一回事', () => {
    assert.equal(readProfile(null), null);
    assert.equal(readProfile(undefined), null);
    const parsed = parsePlan(serializePlan(withProfile(planWithNothing(), null)));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(readProfile(parsed.plan), null);
  });

  it('空档案不会被误当成有档案', () => {
    // 七个字段全空也能解析（schema 里都有 default），但界面得能分清
    // 「访谈留着没做完」和「压根没做过访谈」——那是 `missingProfileFields` 的活。
    const parsed = parsePlan(serializePlan(withProfile(planWithNothing(), readProfileEmpty())));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const p = readProfile(parsed.plan);
    assert.ok(p, '空档案读出来应该是一个对象，不是 null');
    assert.equal(p.goalStatement, null);
    assert.equal(p.weeklyHours, null);
  });
});

function readProfileEmpty(): LearnerProfile {
  return {
    goalStatement: null,
    deadline: null,
    level: null,
    weeklyHours: null,
    weekdays: [],
    weakSpots: [],
    blackouts: [],
  };
}

describe('写档案走的是同一条命令路', () => {
  it('plan.applyAdjustments 的 profile 分支会 +1 版，并把档案写进文件', () => {
    const base = planWithNothing();
    const r = applyCommand(base, {
      type: 'plan.applyAdjustments',
      at: T0,
      applied: [{ kind: 'profile', patch: { weeklyHours: 6 }, reason: '他说这周只有 6 小时' }],
    });
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    if (!r.ok) return;

    assert.equal(r.plan.version, base.version + 1);
    const p = readProfile(r.plan);
    assert.ok(p);
    assert.equal(p.weeklyHours, 6);

    // 而且它是**可序列化**的——不是只挂在内存对象上
    const parsed = parsePlan(serializePlan(r.plan));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(readProfile(parsed.plan)?.weeklyHours, 6);
  });

  it('withProfile 既不就地改原对象，也不和写入的档案共用嵌套结构', () => {
    const base: PlanFile = planWithNothing();
    const source = readProfileEmpty();
    source.weakSpots = ['图论'];
    const next = withProfile(base, source);

    assert.equal(base.profile, null);
    assert.notEqual(next, base);
    assert.ok(next.profile);

    // 改返回的这一份，不能顺着数组串到调用方那份（store 里那份镜像是同一个道理）
    (next.profile as LearnerProfile).weeklyHours = 1;
    (next.profile as LearnerProfile).weakSpots.push('被污染的');
    assert.equal(source.weeklyHours, null);
    assert.deepEqual(source.weakSpots, ['图论']);

    // 反过来也一样：调用方后来改了自己那份，计划里那份是当时那一刻的快照
    source.weakSpots.push('事后加的');
    assert.deepEqual(readProfile(next)?.weakSpots, ['图论', '被污染的']);
  });
});
