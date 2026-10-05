/**
 * 月历运算 —— 纯函数，供日历屏和编辑页的日期选择共用。
 *
 * ## 口径
 *
 * **周一为一周之首**，和机内既有的「本周」口径完全一致
 * （中文语境里「本周」从周一开始，不是周日）。日历的列头是「一 二 三 四 五 六 日」，
 * 所以这里算出来的补格也必须按这个顺序，否则周日的格子会跑到最后一列去。
 *
 * **全部按 UTC 运算**，不碰本地时区。理由是既有代码已经踩过的那条：
 * `new Date('2026-10-19')` 是 UTC 零点，东八区看到的是 10-19 08:00 看着没问题，
 * 但设备时区一旦跑到西半球，同一个字符串就变成 10-18，整份排期错一天。
 *
 * 日期加减**复用 `engine.ts` 的 `addDays`**，不另写一份——同一个项目里
 * 两套日期运算迟早会在某个午夜差一天。
 */
import { addDays } from './engine.ts';

/** '2026-10-19' → '2026-10' */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** 这一天是不是落在 '2026-10' 这个月里 */
export function inMonth(day: string, month: string): boolean {
  return monthOf(day) === month;
}

/** '2026 年 10 月'。标题上的月份。中文里带前导零反而累赘 */
export function monthLabel(day: string): string {
  const [y, m] = day.split('-');
  return `${Number(y)} 年 ${Number(m)} 月`;
}

/** 某年某月有多少天。`Date.UTC(y, m, 0)` 就是「第 m+1 个月的零点」＝ m 月最后一天 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 加减月份，**日期夹到月末**。
 *
 * 这一步不能省：`Date.UTC(2026, 1, 31)`（2 月 31 日）会溢出成 3 月 3 日，
 * 于是「1 月 31 日点下个月」会跳到 3 月——而不是学生预期的 2 月 28 日。
 */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  const date = Math.min(d, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

/** 这一天所在的周一 */
export function startOfWeek(day: string): string {
  // 0=周日。+6 %7 把「周日」映射成 6，于是周一=0
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** 从周一开始的 7 天 */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * 月历要画的 42 天（6 行 × 7 列），周一起。
 *
 * **固定 42 天**，不做「够用就少一行」：行数一变整屏高度就会跳一下，
 * 而学生在月历上做的就是前后翻月份——每翻一次高度抖一下是最刺眼的那种毛病。
 * 代价是有些月份会多出一整行补格，那一行反正也是压暗的（见 `DayCell` 的 muted）。
 */
export const MONTH_GRID_DAYS = 42;

export function monthGridDays(anchor: string): string[] {
  const first = `${monthOf(anchor)}-01`;
  const start = startOfWeek(first);
  return Array.from({ length: MONTH_GRID_DAYS }, (_, i) => addDays(start, i));
}

/* ------------------------------------------------------------------ *
 * 显示用的格式化
 * ------------------------------------------------------------------ *
 * 这些原本只住在移动端的 `lib/dates.ts` 里。搬过来的理由和日期运算一样：
 * **同一件事不能有两个实现**。复盘卡片上要显示「10/21 周三」，
 * 计划页要显示「10月21日 周三」——两处各写一遍，迟早会出现同一天两种说法。
 */

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 星期几的下标。0 = 周日。按 UTC 取，和上面所有日期运算同一个口径 */
function weekdayIndex(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** '周一' */
export function weekdayName(day: string): string {
  return WEEKDAY_CN[weekdayIndex(day)] ?? '';
}

/** 极短标签：'一'。周条的格子里用 */
export function weekdayShort(day: string): string {
  return weekdayName(day).slice(1);
}

/** '10月19日'。中文里带年份反而累赘 */
export function fmtMonthDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** '10/19'。卡片上的「从什么变成什么」用这个，比「10月19日」短一半 */
export function fmtDayShort(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** '10/19 周一'。复盘卡片上的日期 */
export function fmtDayWithWeekday(day: string): string {
  return `${fmtDayShort(day)} ${weekdayName(day)}`;
}

/** 格子里的日号：'19' */
export function dayOfMonth(day: string): string {
  return String(Number(day.split('-')[2]));
}

/** '10月19日 周一' */
export function fmtFull(day: string): string {
  return `${fmtMonthDay(day)} ${weekdayName(day)}`;
}

/** 分钟 → '1 小时 30 分' / '45 分钟'。列表里比 '90 分钟' 更好读 */
export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
