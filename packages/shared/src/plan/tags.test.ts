/**
 * 标记目录的测试。
 *
 * 盯的是三件事：内置目录本身合法、合并规则（自定义覆盖内置）、
 * 以及「认不出来的 id 静默跳过而不是抛」——最后这条决定了
 * 一个陈旧的标记 id 会不会让整条编辑命令被拒。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TAGS, resolveTags, tagById, tagsOf } from './tags.ts';
import { Id, Tag } from './schema.ts';
import type { TagCatalog } from './tags.ts';

const custom = (tags: TagCatalog['tags']): TagCatalog => ({ tags });

describe('内置标记', () => {
  it('每一条都过得了 Tag 校验', () => {
    for (const t of BUILTIN_TAGS) {
      const parsed = Tag.safeParse(t);
      assert.equal(parsed.success, true, `${t.id} 不合法：${parsed.success ? '' : parsed.error.issues[0]?.message}`);
    }
  });

  it('id 唯一，且满足 Id 正则', () => {
    const ids = BUILTIN_TAGS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
    for (const id of ids) assert.equal(Id.safeParse(id).success, true, `${id} 不是合法 id`);
  });

  it('label 够短——它要和状态、类型、时长挤在同一行', () => {
    for (const t of BUILTIN_TAGS) {
      assert.ok(t.label.length <= 6, `${t.label} 在卡片上太长了`);
    }
  });
});

describe('resolveTags', () => {
  it('没有自定义时就是内置那几条', () => {
    assert.deepEqual(resolveTags(custom([])).map((t) => t.id), BUILTIN_TAGS.map((t) => t.id));
  });

  it('没有计划（null / undefined）也不炸', () => {
    assert.equal(resolveTags(null).length, BUILTIN_TAGS.length);
    assert.equal(resolveTags(undefined).length, BUILTIN_TAGS.length);
    assert.equal(resolveTags().length, BUILTIN_TAGS.length);
  });

  it('自定义的加在内置后面', () => {
    const all = resolveTags(custom([{ id: 'tag_mine', label: '我的', tone: 'success' }]));
    assert.equal(all.length, BUILTIN_TAGS.length + 1);
    assert.equal(all.at(-1)!.id, 'tag_mine');
  });

  it('同 id 时自定义覆盖内置（学生能改内置那条的颜色和文案）', () => {
    const all = resolveTags(custom([{ id: 'tag_focus', label: '重中之重', tone: 'success' }]));
    assert.equal(all.length, BUILTIN_TAGS.length, '覆盖不该让条目变多');
    const focus = all.filter((t) => t.id === 'tag_focus');
    assert.equal(focus.length, 1, '不能同时存在内置和自定义两份');
    assert.equal(focus[0]!.label, '重中之重');
    assert.equal(focus[0]!.tone, 'success');
  });
});

describe('tagById / tagsOf', () => {
  it('查得到就返回那一条', () => {
    assert.equal(tagById(custom([]), 'tag_ask')?.label, '想问老师');
  });

  it('查不到返回 undefined，不抛', () => {
    assert.equal(tagById(custom([]), 'tag_不存在'), undefined);
  });

  it('tagsOf 保持传入顺序，并把认不出来的丢掉', () => {
    const got = tagsOf(custom([]), ['tag_error_prone', 'tag_ghost', 'tag_focus']);
    assert.deepEqual(got.map((t) => t.id), ['tag_error_prone', 'tag_focus']);
  });

  it('tagsOf 遇到空数组给空数组', () => {
    assert.deepEqual(tagsOf(custom([]), []), []);
  });

  it('认不出来的 id 不会让别的标记也显示不出来', () => {
    // 这就是「静默跳过」的意义：一条陈旧 id 不该污染整张卡
    const got = tagsOf(custom([{ id: 'tag_mine', label: '我的', tone: 'neutral' }]), [
      'tag_ghost',
      'tag_mine',
      'tag_ghost2',
    ]);
    assert.deepEqual(got.map((t) => t.id), ['tag_mine']);
  });
});

describe('颜色档位和界面用词一致', () => {
  it('内置用到的 tone 都在 schema 的枚举里', () => {
    const allowed = new Set(['neutral', 'accent', 'warning', 'success', 'danger']);
    for (const t of BUILTIN_TAGS) assert.ok(allowed.has(t.tone), `${t.id} 的 tone 不在枚举里`);
  });
});
