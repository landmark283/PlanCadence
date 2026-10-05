/**
 * 应用设置的测试。
 *
 * 只有一条设计要钉住：**读不出来时退回默认值，而不是报错。**
 * 这份文件是程序自己写的，真坏掉时最合理的反应是当作没设置过继续跑。
 * 这和计划文件刚好相反（那份读不出来会明确报错并拒绝覆盖）——
 * 因为计划文件是学生的东西，设置是我们的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, parseSettings, serializeSettings } from './app-settings.ts';

describe('应用设置', () => {
  it('文件不存在时用默认值：正常模式 + 没有上次打开', () => {
    assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings(''), DEFAULT_SETTINGS);
  });

  it('往返之后一模一样', () => {
    const s = { clock: { mode: 'debug' as const, date: '2026-10-19' }, lastSeen: '2026-10-14' };
    assert.deepEqual(parseSettings(serializeSettings(s)), s);
  });

  it('字段缺失时补默认值，而不是整份丢掉', () => {
    // 只写了调试开关，lastSeen 还没写过
    const s = parseSettings('{"clock":{"mode":"debug","date":"2026-10-19"}}');
    assert.equal(s.clock.mode, 'debug');
    assert.equal(s.clock.date, '2026-10-19');
    assert.equal(s.lastSeen, null);
  });

  it('不是 JSON 时退回默认值，不抛异常', () => {
    assert.deepEqual(parseSettings('这不是 JSON'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings('{"clock":'), DEFAULT_SETTINGS);
  });

  it('字段类型不对时退回默认值', () => {
    assert.deepEqual(parseSettings('{"clock":{"mode":"随便"}}'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings('[1,2,3]'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings('"字符串"'), DEFAULT_SETTINGS);
  });

  it('多出来的字段被丢掉，而不是原样带进内存', () => {
    const s = parseSettings('{"clock":{"mode":"live","date":null},"lastSeen":null,"未来字段":1}');
    assert.ok(!('未来字段' in s));
  });

  it('写出去的永远是合法内容', () => {
    const text = serializeSettings({ ...DEFAULT_SETTINGS });
    assert.deepEqual(JSON.parse(text), DEFAULT_SETTINGS);
  });
});
