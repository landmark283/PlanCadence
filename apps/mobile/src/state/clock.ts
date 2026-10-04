/**
 * 演示时钟。
 *
 * 为什么不能直接用 `new Date()`：`applyCommand` 有一条硬规则——命令时间早于
 * `plan.meta.updated` 就拒绝。这条规则本身是对的（防多端乱序写入把 version 推回去），
 * 但示例计划的时间戳是 2026-10 的演示口径，真实系统时间早于它，
 * 于是**每一条命令都会被挡掉**，界面看起来就是「点了没反应」。
 *
 * 所以演示期用一个单调递增的注入式时钟：从计划更新时间之后一分钟起步，
 * 每次调用 +1 分钟。这样同一批命令的相对顺序稳定、可复现，
 * 而且引擎里的「昨天/今天」判断也不会随真实日期漂移。
 *
 * 接上真实数据后，把 `nowStamp` 换回 `new Date().toISOString()` 即可，
 * 调用方一行都不用改。
 */

/** 演示口径的「今天」。示例计划、复盘页、今日页共用这一个值 */
export const DEMO_TODAY = '2026-10-19';

/** 起点：比示例计划的 meta.updated（21:45）晚一分钟 */
const INITIAL_CURSOR = Date.parse('2026-10-19T21:46:00+08:00');
const MINUTE = 60_000;

/** 下一个要发出去的时间戳 */
let cursor = INITIAL_CURSOR;

/**
 * 输出带 +08:00 偏移的 ISO 8601。
 *
 * 不用 `toISOString()`：它固定输出 Z（UTC），而 schema 里的 StampStr 虽然两者都收，
 * 但界面上要显示给学生看时差 8 小时会很困惑。这里统一按北京时间写字面量。
 */
function isoBeijing(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

/** 取下一条命令的时间戳。单调递增 */
export function nowStamp(): string {
  const ms = cursor;
  cursor += MINUTE;
  return isoBeijing(ms);
}

/**
 * 把时钟对齐到不早于 `stamp`。
 *
 * **持久化之后这条是必需的。** 应用重启会把内存里的游标归零，
 * 而计划文件里的 `meta.updated` 已经在上一轮会话里前进过了——
 * 不对齐的话，重启后每一条命令都会被「命令时间早于计划更新时间」拒掉，
 * 表现就是「打开还能看，一操作就没反应」，而且看不出原因。
 *
 * 从设备读回计划后立刻调用它。
 */
export function syncClockTo(stamp: string): void {
  const ms = Date.parse(stamp);
  if (!Number.isNaN(ms) && ms >= cursor) cursor = ms + MINUTE;
}
