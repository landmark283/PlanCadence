/**
 * 时钟的测试。
 *
 * 这里要钉住的是三件事，每一件都对应一个真实踩过的坑：
 *  1. **「今天」不能被时区算偏一天。** 东八区晚上 8 点之后，
 *     拿未加偏移的时间戳去 `toISOString().slice(0,10)` 会得到「明天」。
 *  2. **调试模式必须真的冻结。** 如果它也会随时间流逝，
 *     「模拟隔了 5 天」就成了一个会自己消失的状态，演示没法依赖。
 *  3. **命令时间戳必须可复现且严格递增。** 同一个时间戳出现两次，
 *     历史里两条记录就分不出先后；每次结果不一样，测试就没法断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clockFromDevice,
  clockFromServer,
  clockFromSetting,
  createCursor,
  dayOf,
  DEFAULT_CLOCK_SETTING,
  deviceOffsetMinutes,
  formatStamp,
  isDay,
  MINUTE_MS,
  readingOf,
  type ClockBase,
} from './clock.ts';

const CN = 480;

describe('isDay', () => {
  it('接受真实的日期', () => {
    assert.equal(isDay('2026-10-19'), true);
    assert.equal(isDay('2024-02-29'), true, '2024 是闰年');
  });

  it('拒绝格式不对和根本不存在的日期', () => {
    assert.equal(isDay('2026-2-9'), false, '必须是零填充的两位');
    assert.equal(isDay('2026/10/19'), false);
    assert.equal(isDay(''), false);
    assert.equal(isDay('2026-02-30'), false, '2 月没有 30 号');
    assert.equal(isDay('2025-02-29'), false, '2025 不是闰年');
    assert.equal(isDay('2026-13-01'), false, '没有 13 月');
  });
});

describe('dayOf —— 时区不能把日期算偏一天', () => {
  it('东八区的深夜属于第二天，而不是 UTC 的那一天', () => {
    // 2026-10-19T23:30Z 在东八区是 2026-10-20 07:30
    const ms = Date.parse('2026-10-19T23:30:00Z');
    assert.equal(dayOf(ms, CN), '2026-10-20');
    assert.equal(new Date(ms).toISOString().slice(0, 10), '2026-10-19', '这就是那个错误写法会给出的答案');
  });

  it('东八区的清晨仍属于当天', () => {
    // 2026-10-19T00:30Z 在东八区是 2026-10-19 08:30
    assert.equal(dayOf(Date.parse('2026-10-19T00:30:00Z'), CN), '2026-10-19');
  });

  it('西五区的深夜属于前一天', () => {
    // 2026-10-19T02:00Z 在 UTC-5 是 2026-10-18 21:00
    assert.equal(dayOf(Date.parse('2026-10-19T02:00:00Z'), -300), '2026-10-18');
  });
});

describe('formatStamp', () => {
  it('输出带偏移的字面量，而不是 Z', () => {
    const ms = Date.parse('2026-10-19T13:46:00Z');
    assert.equal(formatStamp(ms, CN), '2026-10-19T21:46:00+08:00');
    assert.equal(formatStamp(ms, -300), '2026-10-19T08:46:00-05:00');
    assert.equal(formatStamp(ms, 0), '2026-10-19T13:46:00+00:00');
  });

  it('半小时时区也能写对', () => {
    assert.equal(formatStamp(Date.parse('2026-10-19T13:46:00Z'), 330), '2026-10-19T19:16:00+05:30');
  });

  it('跨日时日期跟着走', () => {
    assert.equal(formatStamp(Date.parse('2026-10-19T20:00:00Z'), CN), '2026-10-20T04:00:00+08:00');
  });

  it('输出能被 schema 的 StampStr 接受', () => {
    for (const off of [CN, -300, 0, 330, -720]) {
      const s = formatStamp(Date.parse('2026-10-19T13:46:00Z'), off);
      assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, s);
    }
  });
});

describe('基准从哪来', () => {
  const device: ClockBase = clockFromDevice(Date.parse('2026-10-04T10:00:00Z'), CN);

  it('默认设置是正常模式', () => {
    assert.deepEqual(DEFAULT_CLOCK_SETTING, { mode: 'live', date: null });
    assert.equal(clockFromSetting(DEFAULT_CLOCK_SETTING, device), device, '正常模式下设置不生效');
  });

  it('调试模式冻结「今天」，而且不随时间流逝', () => {
    const base = clockFromSetting({ mode: 'debug', date: '2026-10-19' }, device);
    assert.equal(base.frozenToday, '2026-10-19');
    assert.equal(base.source, 'setting');
    assert.equal(readingOf(base).today, '2026-10-19');
    // 同一个基准读很多次都是同一天——它不会自己走
    assert.equal(readingOf(base).today, '2026-10-19');
  });

  it('调试基准的钟点离午夜足够远', () => {
    const base = clockFromSetting({ mode: 'debug', date: '2026-10-19' }, device);
    // 设定日当天 09:00（东八区）= 2026-10-19T01:00Z
    assert.equal(formatStamp(base.ms, CN), '2026-10-19T09:00:00+08:00');
  });

  it('设置里是一个非法日期时退回基准，而不是把一个坏日期当成今天', () => {
    const base = clockFromSetting({ mode: 'debug', date: '2026-02-30' }, device);
    assert.equal(base, device);
    assert.equal(readingOf(base).today, '2026-10-04');
  });

  it('服务端给的基准照单全收', () => {
    const base = clockFromServer({
      nowUtc: '2026-10-19T13:46:00Z',
      offsetMinutes: CN,
      today: '2026-10-19',
    });
    assert.ok(base);
    assert.equal(base.source, 'server');
    assert.equal(base.frozenToday, null, '正常模式不冻结——它会随对表推进');
    assert.equal(readingOf(base).today, '2026-10-19');
  });

  it('服务端返回垃圾时返回 null，让调用方降级', () => {
    assert.equal(clockFromServer({ nowUtc: '不是时间', offsetMinutes: CN, today: '2026-10-19' }), null);
    assert.equal(clockFromServer({ nowUtc: '2026-10-19T13:46:00Z', offsetMinutes: CN, today: '2026-2-9' }), null);
    assert.equal(
      clockFromServer({ nowUtc: '2026-10-19T13:46:00Z', offsetMinutes: Number.NaN, today: '2026-10-19' }),
      null,
    );
  });

  it('降级基准会如实说自己来自设备', () => {
    const base = clockFromDevice(Date.parse('2026-10-19T13:46:00Z'), CN);
    assert.equal(base.source, 'device', '不能把本机时间说成服务端时间');
    assert.equal(readingOf(base).today, '2026-10-19');
  });

  it('设备偏移的符号与 ISO 相反', () => {
    // getTimezoneOffset() 在东八区返回 -480，取负之后是 +480
    const fake = { getTimezoneOffset: () => -480 } as unknown as Date;
    assert.equal(deviceOffsetMinutes(fake), 480);
  });
});

describe('命令时间戳的游标', () => {
  const base = clockFromSetting({ mode: 'debug', date: '2026-10-19' }, clockFromDevice(0, CN));

  it('严格递增，两条命令不会拿到同一个时间戳', () => {
    const c = createCursor();
    const a = c.next(base);
    const b = c.next(base);
    assert.equal(a, '2026-10-19T09:00:00+08:00');
    assert.equal(b, '2026-10-19T09:01:00+08:00');
    assert.notEqual(a, b);
  });

  it('同一串操作产生同一串时间戳（可复现）', () => {
    const run = () => {
      const c = createCursor();
      return [c.next(base), c.next(base), c.next(base)];
    };
    assert.deepEqual(run(), run());
  });

  it('重新对表时游标只前进不后退', () => {
    const c = createCursor();
    c.next(base); // 09:00
    c.next(base); // 09:01
    const older = clockFromSetting({ mode: 'debug', date: '2026-10-01' }, base);
    c.resync(older);
    const at = c.next(older);
    assert.ok(at > '2026-10-19T09:01:00+08:00', `对表到更早的日期之后，命令时间反而倒退了：${at}`);
  });

  it('对表到更晚的日期时跳到基准之后', () => {
    const c = createCursor();
    c.next(base); // 09:00
    const later = clockFromSetting({ mode: 'debug', date: '2026-11-01' }, base);
    c.resync(later);
    assert.equal(c.next(later), '2026-11-01T09:00:00+08:00');
  });

  it('基准比游标晚时不会发出早于基准的命令', () => {
    const c = createCursor();
    const early = clockFromDevice(Date.parse('2026-01-01T00:00:00Z'), CN);
    c.next(early);
    const late = clockFromDevice(Date.parse('2026-06-01T00:00:00Z'), CN);
    assert.equal(c.next(late), formatStamp(late.ms, CN));
  });

  it('读数取自基准而不是游标', () => {
    const c = createCursor();
    // 跑很多条命令，游标漂出去几小时——但「今天」不能被带着翻页
    for (let i = 0; i < 200; i++) c.next(base);
    assert.equal(c.reading(base).today, '2026-10-19');
  });

  it('调试模式下读数永远是设的那一天', () => {
    const c = createCursor();
    const tomorrow = { ...base, ms: base.ms + 5 * MINUTE_MS };
    assert.equal(c.reading(tomorrow).today, '2026-10-19');
  });
});
