/**
 * 字段差分的测试。
 *
 * 这一组是编辑页「保存」能不能点的唯一依据，而它错了的表现很隐蔽：
 * 漏掉一个字段 → 学生改了、保存后没变；多报一个字段 → 每次打开点保存都
 * 白白产生一次写盘和一条「已修改」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blankDraft, draftOf, taskPatch, withScheduledFor } from './task-patch.ts';
import { Task } from './schema.ts';

const task = Task.parse({
  id: 't_01',
  title: '通读动态规划',
  estimateMin: 45,
  type: 'read',
  scheduledFor: '2026-10-20',
  notBefore: null,
  tags: ['tag_focus'],
  dependsOn: ['t_02'],
  resourceIds: ['res_1'],
  notes: '先看概念',
});

describe('draftOf', () => {
  it('取出全部可编辑字段', () => {
    const d = draftOf(task);
    assert.equal(d.title, '通读动态规划');
    assert.equal(d.estimateMin, 45);
    assert.equal(d.scheduledFor, '2026-10-20');
    assert.deepEqual(d.tags, ['tag_focus']);
    assert.deepEqual(d.dependsOn, ['t_02']);
  });

  it('数组是拷贝——改草稿不能改到原计划', () => {
    const d = draftOf(task);
    d.tags.push('tag_ask');
    d.dependsOn.push('t_03');
    assert.deepEqual(task.tags, ['tag_focus']);
    assert.deepEqual(task.dependsOn, ['t_02']);
  });
});

describe('taskPatch：没改就不发命令', () => {
  it('原样草稿返回 null', () => {
    assert.equal(taskPatch(task, draftOf(task)), null);
  });

  it('只多了首尾空格也算没改（否则点一下保存就多一条历史）', () => {
    const d = { ...draftOf(task), title: `  ${task.title}  ` };
    assert.equal(taskPatch(task, d), null);
  });

  it('数组顺序不同不算变化', () => {
    const two = Task.parse({ ...task, tags: ['a_tag', 'b_tag'] });
    const d = { ...draftOf(two), tags: ['b_tag', 'a_tag'] };
    assert.equal(taskPatch(two, d), null);
  });
});

describe('taskPatch：只报真的变了的字段', () => {
  it('只改备注', () => {
    const p = taskPatch(task, { ...draftOf(task), notes: '换一句' });
    assert.deepEqual(Object.keys(p!), ['notes']);
    assert.equal(p!.notes, '换一句');
  });

  it('标题会被 trim 之后再比', () => {
    const p = taskPatch(task, { ...draftOf(task), title: '  新标题  ' });
    assert.equal(p!.title, '新标题');
  });

  it('改日期只报 scheduledFor，不顺手带上 pinned', () => {
    // 「改期默认上锁」是 withScheduledFor 的职责，差分本身是机械的
    const p = taskPatch(task, { ...draftOf(task), scheduledFor: '2026-10-25' });
    assert.deepEqual(Object.keys(p!), ['scheduledFor']);
  });

  it('加标记、删标记各能形成 patch', () => {
    const added = taskPatch(task, { ...draftOf(task), tags: ['tag_focus', 'tag_ask'] });
    assert.deepEqual(added!.tags, ['tag_focus', 'tag_ask']);
    const removed = taskPatch(task, { ...draftOf(task), tags: [] });
    assert.deepEqual(removed!.tags, []);
  });

  it('一次改好几个字段就报好几个', () => {
    const p = taskPatch(task, {
      ...draftOf(task),
      title: '新标题',
      estimateMin: 90,
      scheduledFor: null,
      pinned: true, // 原任务是 false，所以这是一处真变化
    });
    assert.deepEqual(Object.keys(p!).sort(), ['estimateMin', 'pinned', 'scheduledFor', 'title'].sort());
  });

  it('值没变就不报（pinned 本来就是 false 时不该出现在 patch 里）', () => {
    const p = taskPatch(task, { ...draftOf(task), title: '新标题', pinned: false });
    assert.deepEqual(Object.keys(p!), ['title']);
  });

  it('时长改了要报——它进引擎的偏差判定', () => {
    const p = taskPatch(task, { ...draftOf(task), estimateMin: 60 });
    assert.equal(p!.estimateMin, 60);
  });

  it('type / notBefore / dependsOn / resourceIds 都能改', () => {
    const p = taskPatch(task, {
      ...draftOf(task),
      type: 'practice',
      notBefore: '2026-11-09',
      dependsOn: [],
      resourceIds: [],
    });
    assert.equal(p!.type, 'practice');
    assert.equal(p!.notBefore, '2026-11-09');
    assert.deepEqual(p!.dependsOn, []);
    assert.deepEqual(p!.resourceIds, []);
  });
});

describe('withScheduledFor：手动改期默认上锁', () => {
  it('改到别的日子时置 pinned', () => {
    const before = { ...draftOf(task), pinned: false };
    const after = withScheduledFor(before, '2026-10-28');
    assert.equal(after.scheduledFor, '2026-10-28');
    assert.equal(after.pinned, true);
  });

  it('日期没变就什么都不动——打开编辑页再点保存不该给任务上锁', () => {
    const before = { ...draftOf(task), pinned: false };
    const after = withScheduledFor(before, task.scheduledFor);
    assert.equal(after, before, '应该原样返回同一个对象');
    assert.equal(after.pinned, false);
  });

  it('移回待排池也算一次改期', () => {
    const after = withScheduledFor({ ...draftOf(task), pinned: false }, null);
    assert.equal(after.scheduledFor, null);
    assert.equal(after.pinned, true);
  });

  it('改期保存时是真的会写 pinned: true——默认值不只是界面上亮一下', () => {
    const moved = withScheduledFor(draftOf(task), '2026-10-28');
    const p = taskPatch(task, moved);
    assert.deepEqual(Object.keys(p!).sort(), ['pinned', 'scheduledFor']);
    assert.equal(p!.pinned, true);
  });

  it('但默认值不等于强制：学生点掉上锁，就只有日期变', () => {
    const moved = withScheduledFor(draftOf(task), '2026-10-28');
    const unlocked = { ...moved, pinned: false };
    const p = taskPatch(task, unlocked);
    assert.deepEqual(Object.keys(p!), ['scheduledFor']);
    assert.equal(p!.pinned, undefined, '本来就没锁，不该凭空产生一个 pinned 字段');
  });

  it('已上锁的任务被解锁时会写 pinned: false', () => {
    const locked = Task.parse({ ...task, pinned: true });
    const p = taskPatch(locked, { ...draftOf(locked), pinned: false });
    assert.deepEqual(p, { pinned: false });
  });

  it('本来就上锁的任务，改期后还是上锁', () => {
    const after = withScheduledFor({ ...draftOf(task), pinned: true }, '2026-10-28');
    assert.equal(after.pinned, true);
  });
});

describe('blankDraft：新任务的起点', () => {
  it('空标题、45 分钟、阅读类型', () => {
    const d = blankDraft(null);
    assert.equal(d.title, '');
    assert.equal(d.estimateMin, 45);
    assert.equal(d.type, 'read');
    assert.deepEqual(d.tags, []);
    assert.equal(d.scheduledFor, null);
  });

  it('指定了那天就排在那天并上锁（学生是主动排的）', () => {
    const d = blankDraft('2026-10-20');
    assert.equal(d.scheduledFor, '2026-10-20');
    assert.equal(d.pinned, true);
  });

  it('放进待排池时不装作学生排过', () => {
    assert.equal(blankDraft(null).pinned, false);
  });

  it('空草稿配一个空任务时，只有时长和类型算「已改」——界面据此禁用保存', () => {
    const empty = Task.parse({ id: 't_99', title: '占位', estimateMin: 45, type: 'read' });
    const p = taskPatch(empty, { ...blankDraft(null), title: '占位' });
    assert.equal(p, null, '标题一样、其余都是默认值，不该认为有变化');
  });
});
