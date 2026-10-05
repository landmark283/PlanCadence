/**
 * 服务端时钟与 `/time` 的测试。
 *
 * 这个文件存在的唯一理由是钉住一件事：**「今天是哪天」不能被时区算偏一天。**
 * 那个错误只在特定的 UTC 时刻才暴露（东八区晚上 8 点之后会算成「明天」），
 * 所以时钟留了一个注入真实时刻的口子，专门让这些时刻可以被测到。
 *
 * 另外还盯着「冻结」：`SP_TODAY` 是演示和调试赖以成立的东西，
 * 它一旦不生效，示例计划里的日期就会和「今天」差着两周，
 * 而表现只是界面上有些数字看着不对——很难当场发现。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServerClock, frozenInstant, offsetMinutesFor } from './clock.ts';
import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const CN = 'Asia/Shanghai';

describe('offsetMinutesFor', () => {
  it('中国不实行夏令时，全年都是 +480', () => {
    assert.equal(offsetMinutesFor(CN, new Date('2026-01-15T00:00:00Z')), 480);
    assert.equal(offsetMinutesFor(CN, new Date('2026-07-15T00:00:00Z')), 480);
  });

  it('实行夏令时的时区冬夏不同', () => {
    const ny = 'America/New_York';
    assert.equal(offsetMinutesFor(ny, new Date('2026-01-15T12:00:00Z')), -300);
    assert.equal(offsetMinutesFor(ny, new Date('2026-07-15T12:00:00Z')), -240);
  });

  it('半小时时区也能算对', () => {
    assert.equal(offsetMinutesFor('Asia/Kolkata', new Date('2026-01-15T00:00:00Z')), 330);
  });
});

describe('createServerClock', () => {
  it('正常模式跟着真实时间走', () => {
    const at = Date.parse('2026-10-19T13:46:00Z');
    const clock = createServerClock({ today: null, tz: CN, now: () => at });
    assert.equal(clock.today(), '2026-10-19');
    assert.equal(clock.offsetMinutes(), 480);
    assert.equal(clock.nowUtc(), '2026-10-19T13:46:00Z');
    assert.equal(clock.nowStamp(), '2026-10-19T21:46:00+08:00');
    assert.equal(clock.frozen, null);
  });

  it('东八区晚上 8 点之后，「今天」是第二天——不是 UTC 的那一天', () => {
    /**
     * 这条就是那个错误的钉子。
     *
     * 2026-10-19T23:30Z 在东八区已经是 10-20 的早上 7:30。
     * 用 `toISOString().slice(0, 10)` 会得到 10-19，
     * 于是界面上「今天」比实际少一天，逾期判断、补账区间、周视图全部跟着错。
     */
    const clock = createServerClock({ today: null, tz: CN, now: () => Date.parse('2026-10-19T23:30:00Z') });
    assert.equal(clock.today(), '2026-10-20');
  });

  it('冻结时时间恒定，且「今天」就是冻结的那天', () => {
    let tick = 0;
    const clock = createServerClock({ today: '2026-10-19', tz: CN, now: () => 1_000 + tick++ });
    assert.equal(clock.today(), '2026-10-19');
    assert.equal(clock.nowMs(), clock.nowMs(), '冻结之后读多少次都是同一个时刻');
    assert.equal(clock.frozen, '2026-10-19');
    assert.match(clock.nowStamp(), /^2026-10-19T09:00:00\+08:00$/);
  });

  it('冻结时刻离午夜足够远，不会因为偏移算错滑到前一天', () => {
    for (const tz of [CN, 'America/New_York', 'UTC', 'Asia/Kolkata']) {
      const ms = frozenInstant('2026-10-19', tz);
      const clock = createServerClock({ today: '2026-10-19', tz, now: () => ms });
      assert.equal(clock.today(), '2026-10-19', `${tz} 下冻结日滑掉了`);
    }
  });
});

describe('配置：SP_TODAY 与 SP_TZ', () => {
  it('默认不冻结，时区是东八区', () => {
    const r = loadConfig({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.today, null);
      assert.equal(r.config.tz, CN);
    }
  });

  it('能冻结到指定日期', () => {
    const r = loadConfig({ SP_TODAY: '2026-10-19' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.today, '2026-10-19');
  });

  it('日期格式不对时启动就报错，而不是等到算「今天」的时候', () => {
    for (const bad of ['2026/10/19', '26-10-19', '2026-2-9', '']) {
      const r = loadConfig({ SP_TODAY: bad });
      // 空字符串等同于未配置
      assert.equal(r.ok, bad === '');
    }
    const r = loadConfig({ SP_TODAY: '2026-02-30' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /真实存在/);
  });

  it('时区名写错时启动就报错', () => {
    const r = loadConfig({ SP_TZ: 'Mars/Olympus' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /SP_TZ/);
  });
});

describe('GET /time', () => {
  it('返回客户端算不出来的那部分：今天、偏移、时区', async () => {
    const cfg = loadConfig({ SP_TODAY: '2026-10-19' });
    assert.equal(cfg.ok, true);
    if (!cfg.ok) return;
    const app = await buildApp(cfg.config, null, { logger: false });
    const res = await app.inject({ method: 'GET', url: '/time' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.ok, true);
    assert.equal(body.today, '2026-10-19');
    assert.equal(body.offsetMinutes, 480);
    assert.equal(body.zone, CN);
    assert.equal(body.frozen, '2026-10-19', '冻结时要如实告诉客户端，界面要显示出来');
    // 客户端只做算术，这两样必须分开给：给一个 +08:00 字符串会逼它写正则
    assert.match(body.nowUtc, /Z$/);
    assert.match(body.nowStamp, /\+08:00$/);
    await app.close();
  });

  it('不冻结时 frozen 是 null，今天跟着真实时间', async () => {
    const cfg = loadConfig({});
    assert.equal(cfg.ok, true);
    if (!cfg.ok) return;
    const app = await buildApp(cfg.config, null, { logger: false });
    const body = (await app.inject({ method: 'GET', url: '/time' })).json();
    assert.equal(body.frozen, null);
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    await app.close();
  });
});
