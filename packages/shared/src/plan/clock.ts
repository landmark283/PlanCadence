/**
 * 时钟 —— 「今天是哪天」必须是一个能被显式设定的东西，而不是一段藏在代码里的常量。
 *
 * ## 为什么需要它
 *
 * 在这个模块出现之前，「今天」是一个写死的常量（`DEMO_TODAY = '2026-10-19'`），
 * 命令时间戳来自一个从示例计划时间戳起步的假游标。那是被逼出来的：
 * `applyCommand` 当时有一条硬规则「命令时间早于计划更新时间就拒绝」，
 * 而示例计划的时间是演示口径，真实系统时间早于它，于是**每条命令都会被挡掉**，
 * 界面表现就是「点了没反应」。养一个假时钟是为了绕过那条规则。
 *
 * 那条规则已经删了（理由见 commands.ts），所以现在可以直接了当地分成两种模式。
 *
 * ## 两种模式
 *
 * - `debug`：日期由**设置**给，想设哪天设哪天，而且**不会自己走**。
 *   如果它也会随时间流逝，「模拟隔了 5 天」就变成一个会自己消失的状态，
 *   调试和演示都没法依赖它。要前进就手填一个新日期——
 *   前进和后退是同一个操作，于是「回到演示开始那天重演一遍」也成为可能。
 * - `live`：日期由**服务端**给。回到前台时重新对表。
 *
 * ## 为什么不碰 `Intl`
 *
 * Hermes（React Native 的 JS 引擎）是否带 `Intl` 取决于构建配置，
 * 不能让「今天是哪天」这种东西悬在一个可能不存在的 API 上。
 * 所以这里的做法是：**服务端把 `today` 算好再给**，客户端只做纯算术
 * （把 `offsetMinutes` 手工加到 epoch 毫秒上，再用 `getUTC*` 读出来）。
 *
 * 同一个理由让这里也不用 `toISOString().slice(0, 10)` 去算日期——
 * 那是 UTC，东八区晚上 8 点之后会算成「明天」。
 */
import { z } from 'zod';

export const MINUTE_MS = 60_000;

/** 收窄到一个常量，避免各处再 import schema 的私有 regex */
export type DayStr = string;

export const ClockMode = z.enum([
  /** 日期由设置给，不随时间流逝。开发、演示、复现 bug 用 */
  'debug',
  /** 日期由服务端给，回到前台重新对表 */
  'live',
]);
export type ClockMode = z.infer<typeof ClockMode>;

/** 这一次读数是谁给的。界面要如实显示，不能把设备时间说成服务端的 */
export type ClockSource = 'setting' | 'server' | 'device';

export const ClockSetting = z.object({
  mode: ClockMode.default('live'),
  /** 仅 debug 模式使用 */
  date: z.string().nullable().default(null),
});
export type ClockSetting = z.infer<typeof ClockSetting>;

export const DEFAULT_CLOCK_SETTING: ClockSetting = { mode: 'live', date: null };

/** 时钟基准：两种模式共用同一套下游接口，差别只在基准从哪来 */
export type ClockBase = {
  /** 基准时刻（epoch 毫秒） */
  ms: number;
  /** 相对 UTC 的分钟偏移，东八区 = 480 */
  offsetMinutes: number;
  /**
   * 冻结的「今天」。`null` 表示按基准推算。
   *
   * 用字符串而不是布尔量：调试模式下学生设的就是一个日期，
   * 拿它直接当「今天」比拿基准毫秒再去推更不容易出错（也不受时区影响）。
   */
  frozenToday: DayStr | null;
  source: ClockSource;
};

export type ClockReading = {
  today: DayStr;
  source: ClockSource;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 形如 `2026-10-19`，且必须是真实存在的日期（`2026-02-30` 不算） */
export function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/**
 * 输出带时区偏移的 ISO 8601，如 `2026-10-19T21:46:00+08:00`。
 *
 * 不用 `toISOString()`：它固定输出 `Z`。schema 的 `StampStr` 两者都收，
 * 但界面上要显示给学生看时差 8 小时会很困惑，所以写字面量。
 */
export function formatStamp(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/**
 * 某个时刻在给定时区里属于哪一天。
 *
 * 全项目只有这一个地方做「UTC 时刻 → 本地日期」的换算。
 * 每多一个地方做这件事，就多一次把东八区的晚上算成「明天」的机会。
 *
 * 这里的 `toISOString().slice(0, 10)` 是安全的，因为**传入的毫秒已经加过时区偏移**，
 * 读出来的 UTC 日期就是那个时区里的日期。危险的写法是拿**未加偏移**的时间戳直接切——
 * 那正是本模块开头说的那个错误。
 */
export function dayOf(ms: number, offsetMinutes: number): DayStr {
  return new Date(ms + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

/** 调试模式的基准：设定那天的上午 9 点。挑 9 点是为了离任何一个时区的午夜都足够远 */
export function clockFromSetting(setting: ClockSetting, fallback: ClockBase): ClockBase {
  if (setting.mode !== 'debug' || !setting.date || !isDay(setting.date)) return fallback;
  const ms = Date.parse(`${setting.date}T09:00:00Z`) - fallback.offsetMinutes * MINUTE_MS;
  return { ms, offsetMinutes: fallback.offsetMinutes, frozenToday: setting.date, source: 'setting' };
}

/** 正常模式的基准：服务端给什么就是什么 */
export function clockFromServer(t: { nowUtc: string; offsetMinutes: number; today: DayStr }): ClockBase | null {
  const ms = Date.parse(t.nowUtc);
  if (!Number.isFinite(ms) || !isDay(t.today) || !Number.isFinite(t.offsetMinutes)) return null;
  return { ms, offsetMinutes: t.offsetMinutes, frozenToday: null, source: 'server' };
}

/** 降级基准：设备时间。界面会标明「本机时间」，不假装它是服务端的 */
export function clockFromDevice(ms: number, offsetMinutes: number): ClockBase {
  return { ms, offsetMinutes, frozenToday: null, source: 'device' };
}

/** 设备当前的时区偏移（分钟）。`getTimezoneOffset()` 的符号与 ISO 相反，所以取负 */
export function deviceOffsetMinutes(d: Date = new Date()): number {
  return -d.getTimezoneOffset();
}

export function readingOf(base: ClockBase): ClockReading {
  return { today: base.frozenToday ?? dayOf(base.ms, base.offsetMinutes), source: base.source };
}

/**
 * 命令时间戳的游标。
 *
 * **为什么不用真实流逝的时间**：同一批操作必须产生同一串时间戳。
 * 真实时钟在两次点击之间会走掉几百毫秒，命令历史就每次都不一样，
 * 测试没法断言，演示也没法重演。游标保证可复现，而且两次命令不会拿到同一个时间戳
 * （否则历史里两条记录的时间分不出先后）。
 *
 * 基准变了（重新对表、改设置）时游标**只前进不后退**——
 * 后退会让新命令的时间早于上一条，历史读起来就乱了。
 */
export type ClockCursor = {
  /** 取下一个时间戳。这是命令层唯一的 `at` 来源 */
  next(base: ClockBase): string;
  /** 重新对表 */
  resync(base: ClockBase): void;
  /** 当前读数，不推进游标 */
  reading(base: ClockBase): ClockReading;
};

export function createCursor(): ClockCursor {
  let cursor: number | null = null;

  const advance = (base: ClockBase): number => {
    const start = cursor === null ? base.ms : Math.max(cursor, base.ms);
    cursor = start + MINUTE_MS;
    return start;
  };

  return {
    next(base) {
      return formatStamp(advance(base), base.offsetMinutes);
    },
    resync(base) {
      // 只在游标落后时前移。对表到更早的日期不该让时间倒退——
      // 那会让新命令的时间早于上一条，历史读起来就乱了。
      cursor = cursor === null ? base.ms : Math.max(cursor, base.ms);
    },
    reading(base) {
      /**
       * 读数的「今天」取自基准，不取自游标。
       *
       * 游标每发一条命令前进一分钟，跑上几百条命令就会漂出去几小时——
       * 那会让「今天」在长时间使用时莫名其妙地翻页。
       * 正常模式下今天的准确性由「回到前台重新对表」保证。
       */
      return readingOf(base);
    },
  };
}
