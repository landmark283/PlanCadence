/**
 * 日期显示工具（移动端）。
 *
 * **这个文件现在只做转出。** 日期的加减、「本周」的边界、以及所有格式化
 * 全部住在 `@sp/shared` 的 `plan/calendar.ts` 和 `plan/engine.ts` 里。
 *
 * 为什么不让它继续自己实现：加日历那一轮踩到了——`weekdayName` 这类东西
 * 移动端有一份、shared 也要用一份，两处只要有一处改了措辞（「周一」还是「星期一」），
 * 同一天在不同屏上就会有两种说法。这类分歧**不会报错**，只会让人觉得拼装。
 *
 * 保留这个文件的理由只有一个：`@/lib/dates` 这个导入路径已经被几十处用着，
 * 换掉它是一次没有收益的大改。
 */
export {
  addDays,
  daysBetween,
  startOfWeek,
  weekDays,
  weekdayName,
  weekdayShort,
  fmtMonthDay,
  fmtDayShort,
  fmtDayWithWeekday,
  dayOfMonth,
  fmtFull,
  fmtMinutes,
} from '@sp/shared';
