/**
 * 导出格式的测试。
 *
 * 这两种格式的错都**极难在真机上定位**：ICS 写错了，表现是"日历说这个文件打不开"，
 * 不会告诉你哪一行错了；Markdown 写错了，表现是渲染出来乱掉。
 * 所以把规范里那几条容易踩的逐条钉住：
 *
 *   · CRLF、折行按 **75 字节**、且不在多字节字符中间切
 *   · 全天事件的 DTEND 是**次日**（开区间），写成同一天会变零长度
 *   · 值的转义（`\` `;` `,` 换行）
 *   · UID 稳定，重复导入是更新而不是又加一份
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toIcs, toMarkdown, exportBaseName, foldIcsLine } from './export.ts';
import { PlanFile, emptyPlan } from './schema.ts';
import { parsePlan } from './io.ts';

const AT = '2026-10-19T21:46:00+08:00';

/** 一份够用的小计划，字段都在 */
function plan(): PlanFile {
  const p = emptyPlan('plan_t', AT, '测试计划');
  p.goal.statement = '明年四月能独立做出省赛中等难度的题';
  p.goal.successCriteria = ['独立 AC 30 道中等题'];
  p.goal.deadline = '2027-04-11';
  p.constraints.weeklyMinutes = 600;
  p.constraints.blackouts = [{ from: '2026-11-02', to: '2026-11-06', reason: '期中考试周' }];
  p.competences = [{ id: 'c_1', name: '动态规划', target: 0.8, current: 0.25, evidence: [] }];
  p.milestones = [
    { id: 'm_1', title: '基础巩固', due: '2026-11-30', competenceIds: ['c_1'], status: 'active', criteria: ['能独立写出背包三种变体'] },
  ];
  p.tasks = [
    {
      id: 't_1', title: '通读「动态规划」的核心概念', milestoneId: 'm_1', dependsOn: [],
      estimateMin: 45, type: 'read', status: 'done', scheduledFor: '2026-10-21',
      pinned: false, notBefore: null, actualMin: 60, difficulty: null, resourceIds: [], notes: '',
    },
    {
      id: 't_2', title: '「动态规划」模板题 3 道', milestoneId: 'm_1', dependsOn: ['t_1'],
      estimateMin: 90, type: 'practice', status: 'todo', scheduledFor: '2026-10-22',
      pinned: false, notBefore: null, actualMin: null, difficulty: null, resourceIds: [], notes: '先做 01 背包',
    },
    {
      id: 't_3', title: '还没排的复习', milestoneId: null, dependsOn: [],
      estimateMin: 30, type: 'review', status: 'skipped', scheduledFor: null,
      pinned: false, notBefore: null, actualMin: null, difficulty: null, resourceIds: [], notes: '',
    },
  ];
  p.resources = [
    { id: 'r_1', title: 'OI Wiki · 动态规划', url: 'https://oi-wiki.org/dp/', kind: 'article', verifiedAt: `${AT}`, source: '资料库快照@2026-10-19', deadline: null },
    { id: 'r_2', title: '校内模拟赛', url: 'https://example.edu.cn/x', kind: 'contest', verifiedAt: `${AT}`, source: '校内通知', deadline: '2026-11-15' },
  ];
  return p;
}

describe('Markdown 导出', () => {
  const md = () => toMarkdown(plan(), { at: AT });

  it('目标原话在最上面，且带截止日与进度', () => {
    const out = md();
    assert.ok(out.startsWith('# 明年四月能独立做出省赛中等难度的题'));
    assert.match(out, /截止\*\* 2027-04-11/);
    assert.match(out, /进度\*\* 1\/3 项/);
  });

  it('按日期分组，已完成的打 x，跳过状态写出来', () => {
    const out = md();
    assert.match(out, /### 2026-10-21 · 1\/1 项/);
    assert.match(out, /- \[x\] 通读「动态规划」的核心概念/);
    assert.match(out, /- \[ \] 「动态规划」模板题 3 道/);
    assert.match(out, /已跳过/, '跳过和未完成必须能区分');
  });

  it('实际用时与前置依赖都写出来', () => {
    const out = md();
    assert.match(out, /实际 1 小时/);
    assert.match(out, /等待「通读「动态规划」的核心概念」/);
  });

  it('不可用日期与资料链接都在', () => {
    const out = md();
    assert.match(out, /2026-11-02 ~ 2026-11-06（期中考试周）/);
    assert.match(out, /\[OI Wiki · 动态规划\]\(https:\/\/oi-wiki\.org\/dp\/\)/);
    assert.match(out, /截止 2026-11-15/);
  });

  it('标题里的 Markdown 特殊字符会被转义，不会把结构撑坏', () => {
    const p = plan();
    p.tasks[0]!.title = '看 [链接] 和 *星号* 与 _下划线_';
    const out = toMarkdown(p, { at: AT });
    assert.match(out, /\\\[链接\\\]/);
    assert.ok(!/\*星号\*(?!\\)/.test(out.replace('\\*星号\\*', '')), '星号应被转义');
  });

  it('标题里混进换行也不会破坏列表结构', () => {
    const p = plan();
    p.tasks[0]!.title = '第一行\n第二行';
    const out = toMarkdown(p, { at: AT });
    const lines = out.split('\n');

    // 意图是「换行被压平」，不是「这个标题只出现一次」——
    // 它本来就会出现在两处：自己那一行，以及依赖它的任务里的「等待「…」」
    for (const l of lines.filter((x) => x.includes('第一行'))) {
      assert.ok(l.includes('第二行'), `标题被拆到了两行：${JSON.stringify(l)}`);
    }
    // 不允许有一行是接着标题后半段单独开头的——那说明换行漏进了结构里
    assert.equal(
      lines.filter((l) => l.trimStart().startsWith('第二行')).length,
      0,
      '后半段单独成行了，列表结构被撑坏',
    );
  });

  it('没有已排期任务时给一句话，而不是空白', () => {
    const p = plan();
    p.tasks = p.tasks.map((t) => ({ ...t, scheduledFor: null }));
    assert.match(toMarkdown(p, { at: AT }), /暂无已排期的任务/);
  });

  it('导出的文件名带目标与日期，比内部 id 好认', () => {
    const name = exportBaseName(plan(), '2026-10-19');
    assert.match(name, /^学习计划-/);
    assert.ok(name.includes('2026-10-19'));
    assert.ok(!name.includes('/'), '文件名里不能有路径分隔符');
  });
});

describe('ICS 导出', () => {
  const ics = () => toIcs(plan(), { at: AT });

  it('用 CRLF 换行，且以 CRLF 结尾（RFC 5545 要求）', () => {
    const out = ics();
    assert.ok(out.includes('\r\n'));
    assert.ok(out.endsWith('\r\n'));
    // 不能有落单的 \n
    assert.equal(out.split('\r\n').join('').includes('\n'), false, '有落单的 \\n');
  });

  it('骨架完整且成对', () => {
    const out = ics();
    assert.ok(out.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(out.trimEnd().endsWith('END:VCALENDAR'));
    const begin = out.match(/BEGIN:VEVENT/g)?.length ?? 0;
    const end = out.match(/END:VEVENT/g)?.length ?? 0;
    assert.equal(begin, end);
    assert.equal(begin, 3, '两个已排期任务 + 一个赛事截止');
    for (const key of ['VERSION:2.0', 'PRODID:', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']) {
      assert.ok(out.includes(key), `缺 ${key}`);
    }
  });

  it('全天事件的 DTEND 是次日，不是同一天', () => {
    const out = ics();
    assert.ok(out.includes('DTSTART;VALUE=DATE:20261021'));
    assert.ok(out.includes('DTEND;VALUE=DATE:20261022'), 'DTEND 是开区间，必须填次日');
  });

  it('没排期的任务不生成事件', () => {
    assert.ok(!ics().includes('还没排的复习'));
  });

  it('DTSTAMP 是 UTC 形式', () => {
    assert.match(ics(), /DTSTAMP:\d{8}T\d{6}Z/);
  });

  it('UID 稳定：同一个计划导出两次，事件 UID 完全一致（导入是更新而不是又加一份）', () => {
    const a = ics().match(/UID:.*/g) ?? [];
    const b = ics().match(/UID:.*/g) ?? [];
    assert.ok(a.length > 0);
    assert.deepEqual(a, b);
    assert.ok(a.every((u) => u.includes('plan_t-')), 'UID 里要带计划 id，避免两个计划撞车');
  });

  it('SEQUENCE 跟着计划版本走，客户端才知道这是更新', () => {
    const p = plan();
    p.version = 7;
    assert.ok(toIcs(p, { at: AT }).includes('SEQUENCE:7'));
  });

  it('赛事截止带提前一天的提醒', () => {
    const out = ics();
    assert.ok(out.includes('TRIGGER:-P1D'));
    assert.ok(out.includes('SUMMARY:截止：校内模拟赛'));
    // 普通学习任务不该有提醒，否则日历会被通知淹没
    assert.equal(out.match(/TRIGGER/g)?.length, 1);
  });

  it('值里的分号逗号反斜杠被转义，不会破坏行结构', () => {
    const p = plan();
    p.tasks[0]!.title = 'a;b,c\\d';
    const out = toIcs(p, { at: AT });
    assert.ok(out.includes('SUMMARY:a\\;b\\,c\\\\d'), '转义不全');
  });

  it('**折行按 75 字节，且不在多字节字符中间切**', () => {
    // 中文一个字 3 字节，75 字节能放 25 个字；标题长一点必然折行
    const out = toIcs(plan(), { at: AT });
    for (const line of out.split('\r\n')) {
      // 折行后每一行的 UTF-8 字节数都不能超过 75
      let bytes = 0;
      for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      }
      assert.ok(bytes <= 75, `某行 ${bytes} 字节，超了：${line}`);
    }
  });

  it('折行后能拼回原值（没有丢字符、没有切坏汉字）', () => {
    const long = '复习：' + '动态规划'.repeat(20);
    const folded = foldIcsLine(`SUMMARY:${long}`);
    // 去掉续行开头的那个空格再拼回来
    const unfolded = folded.split('\r\n').map((l, i) => (i === 0 ? l : l.slice(1))).join('');
    assert.equal(unfolded, `SUMMARY:${long}`);
    assert.ok(!unfolded.includes('\uFFFD'), '出现了替换字符，说明切坏了多字节字符');
  });

  it('短行不折', () => {
    assert.equal(foldIcsLine('SUMMARY:短'), 'SUMMARY:短');
  });
});

describe('导出的东西还能被自己读回来', () => {
  it('markdown 里出现的目标原话，和计划文件里的一致', () => {
    const p = plan();
    assert.ok(toMarkdown(p, { at: AT }).includes(p.goal.statement));
  });

  it('导出不修改原计划（纯函数）', () => {
    const p = plan();
    const snapshot = JSON.stringify(p);
    toMarkdown(p, { at: AT });
    toIcs(p, { at: AT });
    assert.equal(JSON.stringify(p), snapshot);
  });

  it('示例文件导出的 ICS 也能过一遍结构检查', () => {
    const url = new URL('../../../../examples/demo.studyplan', import.meta.url);
    const parsed = parsePlan(readFileSync(url, 'utf8'));
    assert.equal(parsed.ok, true, parsed.ok ? '' : String(parsed.error));
    if (!parsed.ok) return;
    const out = toIcs(parsed.plan, { at: AT });
    assert.equal(out.match(/BEGIN:VEVENT/g)?.length, out.match(/END:VEVENT/g)?.length);
    assert.ok(out.includes('BEGIN:VCALENDAR'));
  });
});
