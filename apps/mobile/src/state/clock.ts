/**
 * 应用的时钟 —— 全 App 唯一的「今天是哪天」和「现在是几点」。
 *
 * ## 它在解决什么问题
 *
 * 在这之前，「今天」是一个写死的常量（`DEMO_TODAY = '2026-10-19'`），
 * 命令时间戳来自一个从示例计划时间戳起步的假游标。那是被逼出来的：
 * `applyCommand` 当时有一条硬规则「命令时间早于计划更新时间就拒绝」，
 * 而示例计划的时间是演示口径，真实系统时间早于它，于是**每条命令都会被挡掉**，
 * 界面表现就是「点了没反应」。养一个假时钟是为了绕过那条规则。
 *
 * 那条规则已经删了（理由见 `@sp/shared` 的 commands.ts），所以现在可以直接了当：
 * 调试模式就用设置里的日期，正常模式就问服务端。
 *
 * ## 为什么是一个模块级单例
 *
 * 因为整个 App 只服务**一份**计划（`PLAN_ID` 是常量）。把它做成一个可注入的
 * 对象只会让每一层都要多传一个参数，而收益是零。真要支持多份计划时，
 * 这里会跟着 `plan-store` 一起变成按计划 id 分组的——那时再改。
 *
 * ## 「今天」为什么在两种模式下都可能不刷新
 *
 * 调试模式下它**故意**不刷新（那正是这个模式的意义：设了哪天就是哪天，
 * 要前进就手填一个新日期）。正常模式下由 `plan-store` 在回到前台时重新对表。
 * 这个模块自己不跑定时器——一个每分钟醒一次、绝大多数时候什么都不做的
 * 定时器，在手机上是要用电池换的。
 */
import {
  clockFromDevice,
  clockFromSetting,
  clockFromServer,
  createCursor,
  deviceOffsetMinutes,
  readingOf,
  type ClockBase,
  type ClockReading,
  type ClockSetting,
  type ClockSource,
  type DayStr,
} from '@sp/shared';

/** 兜底基准：设备时间。界面会标明「本机时间」，不假装它是服务端的 */
export function baseFromDevice(nowMs: number = Date.now()): ClockBase {
  return clockFromDevice(nowMs, deviceOffsetMinutes());
}

/** 调试模式：用设置里的日期；设置不合法时原样返回传入的兜底基准 */
export function baseFromSetting(setting: ClockSetting, fallback: ClockBase = baseFromDevice()): ClockBase {
  return clockFromSetting(setting, fallback);
}

/** 正常模式：用服务端给的读数；返回 null 表示这次对表失败，调用方应保持原基准 */
export function baseFromTime(t: { nowUtc: string; offsetMinutes: number; today: DayStr }): ClockBase | null {
  return clockFromServer(t);
}

/**
 * 当前基准。所有读数都从它来。
 *
 * 初值是设备时间：这样即使 `GET /time` 还没回来、设置也还没读出来，
 * 界面上的日期至少是「对的」（用户自己的表），而不是一个写死的演示日期。
 */
let base: ClockBase = baseFromDevice();
const cursor = createCursor();

/**
 * 换一个基准（启动、回到前台、学生改了设置）。
 *
 * 游标只前进不后退——对表到更早的日期不该让命令时间倒退，
 * 那会让历史里两条记录的先后分不出来。
 */
export function setBase(next: ClockBase): ClockReading {
  base = next;
  cursor.resync(next);
  return readingOf(next);
}

export function currentBase(): ClockBase {
  return base;
}

/** 现在是哪天。这是全 App 唯一的答案 */
export function today(): DayStr {
  return readingOf(base).today;
}

export function reading(): ClockReading {
  return readingOf(base);
}

export function nowSource(): ClockSource {
  return base.source;
}

/**
 * 取下一个命令时间戳。
 *
 * **这是命令层唯一的 `at` 来源。** 用游标而不是真实流逝的时间，
 * 是因为同一批操作必须产生同一串时间戳：真实时钟在两次点击之间会走掉几百毫秒，
 * 命令历史就每次都不一样，测试没法断言，演示也没法重演。
 */
export function nextStamp(): string {
  return cursor.next(base);
}
