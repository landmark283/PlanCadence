/**
 * 日期工具。
 *
 * 全部按 **UTC 正午** 做运算，不用本地时区。
 * 理由：`new Date('2026-10-19')` 会被解析成 UTC 零点，在东八区显示是 10-19 08:00，
 * 本来看起来没问题；但一旦有人把设备时区改成西半球，同一个字符串就会变成 10-18，
 * 排期整体错一天。用 UTC 存取、只在格式化时当纯数字处理，可以彻底绕开这件事。
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

function toMs(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromMs(toMs(day) + n * DAY_MS);
}

/** 周一为一周之首。中文语境里「本周」默认从周一开始，不是周日 */
export function startOfWeek(day: string): string {
  const dow = new Date(toMs(day)).getUTCDay(); // 0=周日
  return addDays(day, -((dow + 6) % 7));
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** '周一' */
export function weekdayName(day: string): string {
  return WEEKDAYS[new Date(toMs(day)).getUTCDay()] ?? '';
}

/** 周条上的极短标签：'一' */
export function weekdayShort(day: string): string {
  return weekdayName(day).slice(1);
}

/** '10月19日'。中文里带年份反而累赘 */
export function fmtMonthDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** 周条格子里的日号：'19' */
export function dayOfMonth(day: string): string {
  return String(Number(day.split('-')[2]));
}

/** '10月19日 周一' */
export function fmtFull(day: string): string {
  return `${fmtMonthDay(day)} ${weekdayName(day)}`;
}

/** 两个日期相差几天（b - a）。用于倒计时 */
export function daysBetween(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/** 分钟 → '1 小时 30 分' / '45 分钟'。列表里比 '90 分钟' 更好读 */
export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
