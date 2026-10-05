/**
 * 两条守着「原生上的 key 警告」的检查。
 *
 * ## 为什么需要静态检查
 *
 * 那个警告**只在真机上出现**（原因见 `src/lib/child-keys.ts` 的文件头：
 * RN 的 ScrollView 无条件跑 `React.Children.toArray`，而 react-native-web 不跑），
 * 所以截图、端到端、类型检查、单测——现有的**每一层验证都看不见它**。
 * 唯一能在开发机上跑的判据就是「别再有人直接用 ScrollView」。
 *
 * 这不是形式主义：真机上报这一条时，屏幕上只写着
 * 「Check the render method of RCTView. It was passed a child from TalkScreen.」,
 * 而根因在 react-native 内部——从报错反推回这一行规矩，代价很高。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, isValidElement } from 'react';

import { withChildKeys } from '../src/lib/child-keys.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('ScrollView 只能通过 ScrollBody 用', () => {
  it('app/ 与 components/ 里没有裸的 ScrollView', () => {
    const files = [
      ...walk(path.join(SRC, 'app')),
      ...walk(path.join(SRC, 'components')),
    ].filter((f) => f.endsWith('.tsx') && path.basename(f) !== 'scroll-body.tsx');

    const offenders = files.filter((f) => /<\/?ScrollView/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(
      offenders.map((f) => path.relative(SRC, f)),
      [],
      '这些文件直接用了 ScrollView。原生上它会把没有 key 的子节点标成 validated=2，' +
        '然后报「Each child in a list should have a unique key prop」；请改用 @/components/scroll-body。'
    );
  });

  it('ScrollBody 自己确实在跑那段 Children.toArray（没有就白防了）', () => {
    // 如果哪天 react-native 不再无条件 toArray，这条会失败，提醒我们回来删掉这层
    const rn = 'node_modules/react-native/Libraries/Components/ScrollView/ScrollView.js';
    if (!fs.existsSync(path.join(HERE, '..', '..', '..', rn))) return; // 依赖没装就跳过
    const text = fs.readFileSync(path.join(HERE, '..', '..', '..', rn), 'utf8');
    assert.match(text, /React\.Children\.toArray/, 'RN 的 ScrollView 不再无条件 toArray 了，可以回来看这层是否还需要');
  });
});

describe('withChildKeys 的契约', () => {
  const el = (name) => createElement('div', { name });

  it('给没有 key 的元素补上 key', () => {
    const out = withChildKeys([el('a'), el('b')]);
    assert.equal(out.length, 2);
    for (const c of out) {
      assert.ok(isValidElement(c));
      assert.notEqual(c.key, null, '每个元素都必须有 key，否则 RN 的 toArray 会标 validated=2');
      assert.equal(typeof c.key, 'string');
    }
    // 位置不同 → key 不同
    assert.notEqual(out[0].key, out[1].key);
  });

  it('本来有 key 的不动（列表的键是业务 id，比位置键好）', () => {
    const keyed = createElement('div', { key: 't_07', name: 'task' });
    const [out] = withChildKeys([keyed]);
    assert.equal(out, keyed, '带 key 的应当原样返回，连克隆都不要');
    assert.equal(out.key, 't_07');
  });

  it('null / 字符串 / 数字原样放过（条件为假时就是 null）', () => {
    const out = withChildKeys([null, '文字', 3, undefined]);
    assert.deepEqual(out, [null, '文字', 3, undefined]);
  });

  it('数组里套数组也补：`{items.map(...)}` 作为子节点时就是这种形状', () => {
    const inner = [el('x'), el('y')];
    const out = withChildKeys([el('first'), inner]);
    assert.ok(Array.isArray(out[1]));
    for (const c of out[1]) {
      assert.ok(isValidElement(c));
      assert.notEqual(c.key, null);
    }
  });

  it('不是数组（只有一个子节点）时原样返回', () => {
    const single = el('only');
    assert.equal(withChildKeys(single), single);
    assert.equal(withChildKeys(null), null);
    assert.equal(withChildKeys('纯文字'), '纯文字');
  });

  it('不改 props：补 key 只是补 key', () => {
    const out = withChildKeys([createElement('div', { name: 'keep-me', id: 7 })]);
    assert.equal(out[0].props.name, 'keep-me');
    assert.equal(out[0].props.id, 7);
  });
});
