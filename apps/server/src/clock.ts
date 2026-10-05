/**
 * 服务端时钟 —— 全服务唯一的「现在」。
 *
 * ## 为什么必须只有一个
 *
 * 在这之前，同一个「今天」在项目里有**四个**来源：
 *   · 客户端一个写死的演示常量；
 *   · `routes/plan.ts` 里一份 `todayLocal()` + 一份 `nowStamp()`；
 *   · `routes/interview.ts` 里又抄了一份 `nowStamp()`；
 *   · `tools/codeforces.ts` 里直接读 `Date.now()`。
 *
 * 它们会互相矛盾，而且已经矛盾过一次：演示时钟是 2026-10-19，
 * 实时赛程却按真实的 2026-10-04 过滤，于是抓回来的每一场都渲染成
 * 「已截止 12 天」。当时的处理是在标题里保留日期、抑制倒计时——
 * 那是绕过，不是修复。**同一个事实有多个来源，就一定会不一致。**
 *
 * ## 冻结
 *
 * `SP_TODAY` 会把时间冻结在指定日期的本地 09:00。挑 9 点是因为它离任何
 * 一个时区的午夜都足够远，不会因为偏移算错而滑到前一天或后一天。
 *
 * 冻结之后 `now` 恒定不变。命令时间戳的单调性由**客户端**的游标保证
 * （见 shared 的 `createCursor`），服务端不需要为此假装时间在走。
 */
import { dayOf, formatStamp } from '@sp/shared';
import type { ServerConfig } from './config.ts';

export type ServerClock = {
  /** 当前时刻（epoch 毫秒）。冻结时恒定 */
  nowMs(): number;
  /** ISO 8601，UTC（结尾 Z）。给机器用 */
  nowUtc(): string;
  /** ISO 8601，带本地偏移。给人读 */
  nowStamp(): string;
  /** 本地时区的今天，`YYYY-MM-DD`。**全服务唯一的「今天是哪天」** */
  today(): string;
  offsetMinutes(): number;
  zone: string;
  /** 被 `SP_TODAY` 冻结时为那一天，否则 null */
  frozen: string | null;
};

/**
 * 某个时区在某个时刻的 UTC 偏移（分钟）。
 *
 * 做法是把该时区的本地时间用 `Intl` 读出来，当成 UTC 再和真实 UTC 求差。
 * 不能用一个常量：中国不用夏令时，但别人用，而且 `SP_TZ` 是可配的。
 */
export function offsetMinutesFor(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** 冻结时刻：那天的本地 09:00 */
export function frozenInstant(day: string, tz: string): number {
  const rough = Date.parse(`${day}T09:00:00Z`);
  return rough - offsetMinutesFor(tz, new Date(rough)) * 60_000;
}

export type ServerClockOptions = Pick<ServerConfig, 'today' | 'tz'> & {
  /**
   * 真实时刻的来源。只有测试会传它。
   *
   * 之所以留这个口子：本文件存在的理由就是「今天是哪天不能被时区算偏一天」，
   * 而那条错误只在**特定的 UTC 时刻**（东八区晚上 8 点之后）才暴露。
   * 不给注入点就只能靠「跑到那个点再测」，那等于没测。
   */
  now?: () => number;
};

export function createServerClock(opts: ServerClockOptions): ServerClock {
  const zone = opts.tz;
  const frozen = opts.today;
  const realNow = opts.now ?? Date.now;
  const fixedMs = frozen ? frozenInstant(frozen, zone) : null;

  const ms = () => fixedMs ?? realNow();
  const offset = () => offsetMinutesFor(zone, new Date(ms()));

  return {
    nowMs: ms,
    nowUtc: () => new Date(ms()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    nowStamp: () => formatStamp(ms(), offset()),
    today: () => (frozen ? frozen : dayOf(ms(), offset())),
    offsetMinutes: offset,
    zone,
    frozen,
  };
}
