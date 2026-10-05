/**
 * 任务 id 生成的测试。
 *
 * 重点不是「能不能生成一个 id」，而是三件事：
 *   · 生成的 id **一定过得了 schema 的 `Id` 正则**（否则任务存不进计划文件）；
 *   · **一定不和现有的撞**（否则会静默覆盖别人的任务，`validatePlan` 只说「id 重复」）；
 *   · 是**纯函数**——同样的输入永远给同样的输出，不读时钟也不读随机数。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newTaskId } from './ids.ts';
import { Id } from './schema.ts';

describe('newTaskId', () => {
  it('空计划给 t_01', () => {
    assert.equal(newTaskId([]), 't_01');
  });

  it('接着最大序号往后走', () => {
    assert.equal(newTaskId(['t_01', 't_02']), 't_03');
    assert.equal(newTaskId(['t_02', 't_01']), 't_03', '顺序不该影响结果');
    assert.equal(newTaskId(['t_09']), 't_10');
  });

  it('不看有几个任务，只看最大序号', () => {
    // 中间被删过：只有 t_01 和 t_05，下一个必须是 t_06 而不是「第一个空位」t_02
    assert.equal(newTaskId(['t_01', 't_05']), 't_06');
  });

  it('序号过百之后仍然合法，且不再是两位', () => {
    const id = newTaskId(['t_99']);
    assert.equal(id, 't_100');
    assert.equal(Id.safeParse(id).success, true, 'Id 正则不允许三位数就说明这里错了');
  });

  it('混着非数字 id 时不被干扰', () => {
    assert.equal(newTaskId(['t_a', 't_b']), 't_01');
    assert.equal(newTaskId(['t_a', 't_07']), 't_08');
    // 't_007' 会被 NUMBERED 认出来（\d+），序号是 7
    assert.equal(newTaskId(['t_007']), 't_08');
  });

  it('结果永远过得了 Id 正则', () => {
    const samples: string[][] = [[], ['t_a'], ['t_01'], ['t_99'], ['t_1000'], ['t_x', 't_42'], ['res_cf_1']];
    for (const existing of samples) {
      const id = newTaskId(existing);
      const parsed = Id.safeParse(id);
      assert.equal(parsed.success, true, `${JSON.stringify(existing)} → ${id} 不合法`);
    }
  });

  it('结果一定不在现有集合里', () => {
    const existing = ['t_01', 't_02', 't_03'];
    assert.equal(existing.includes(newTaskId(existing)), false);
  });

  it('是纯函数：同样输入给同样输出', () => {
    const existing = ['t_03', 't_01'];
    assert.equal(newTaskId(existing), newTaskId(existing));
  });

  it('遇到被占用的连续序号会顺延过去', () => {
    // t_04 已存在但 max 是 5，所以从 6 开始——顺延的分支走的是「候选被占用」
    assert.equal(newTaskId(['t_05', 't_06']), 't_07');
  });

  it('不会重用刚被删掉的任务 id', () => {
    // 顺序号往下走而不是找空位，这条是那个决定的直接后果
    assert.notEqual(newTaskId(['t_01', 't_03']), 't_02');
  });
});
