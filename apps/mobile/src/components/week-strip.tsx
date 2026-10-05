/**
 * 横向周条 —— 「本周负载」的一眼可见形态。
 *
 * 每一天是一格，格子里从上到下是「周几 / 日号 / 负载条」。
 * 负载条用长度而不是颜色表达多少：颜色已经被状态占用了，
 * 再来一套颜色编码，学生就得同时维护两张对照表。
 *
 * **这一格的内容和配色现在住在 `components/day-cell.tsx`**，月历用的是同一个组件
 * （区别只有「周几」那一行由列头承担，所以 `showWeekday` 传 false）。
 * 这里只剩「排成一行」和「一行的格子该多高」。
 */
import { StyleSheet, View } from 'react-native';

import { DayCell, type DayLoad } from '@/components/day-cell';
import { space, touchTarget } from '@/theme';

/** 周条的格子比月历高一档：它要多放一行「周几」小字 */
export const STRIP_CELL_MIN_HEIGHT = touchTarget + 22;

/** 这个类型就是「一天的负载」，和月历共用 */
export type WeekStripDay = DayLoad;

export type WeekStripProps = {
  days: WeekStripDay[];
  selected: string;
  onSelect: (day: string) => void;
  /** 负载条的满格基准（分钟）。默认 120——一个晚上的合理上限 */
  fullAt?: number;
};

export function WeekStrip({ days, selected, onSelect, fullAt }: WeekStripProps) {
  return (
    <View style={styles.row}>
      {days.map((d) => (
        <DayCell
          key={d.day}
          load={d}
          selected={d.day === selected}
          showWeekday
          fullAt={fullAt}
          onPress={() => onSelect(d.day)}
          style={styles.cell}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.xs,
  },
  cell: {
    minHeight: STRIP_CELL_MIN_HEIGHT,
  },
});
