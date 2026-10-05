/**
 * 月历面板 —— 星期表头 + 6×7 的日程格子 + 翻月。
 *
 * ## 谁用它
 *
 * 日历屏，以及编辑页里的「挑个日子」。
 * 两处**渲染的是同一个组件**——各写一遍月历必然长歪：列宽、行高、周起始日、
 * 补格压暗的程度，总有一个地方不一样，而这恰恰是「风格一致」最容易破的地方。
 *
 * ## 它自己不管状态
 *
 * `month` / `selected` / `loads` 全部由调用方给，翻月也只上报（`onMonthChange`）。
 * 这样日历屏能自己持有「我在看哪个月」，编辑页则能把它接到草稿上。
 *
 * ## 为什么固定 6 行
 *
 * `monthGridDays` 永远返回 42 天。行数一变整屏高度就会跳一下，
 * 而学生在月历上做的就是前后翻月份——每翻一次高度抖一下是最刺眼的毛病。
 * 代价是有些月份会多出一整行补格，那一行反正也是压暗的。
 */
import { StyleSheet, View } from 'react-native';
import { inMonth, monthGridDays, monthLabel, monthOf } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { ChipAction } from '@/components/card';
import { DayCell, LOAD_FULL_AT, type DayLoad } from '@/components/day-cell';
import { space, useTokens } from '@/theme';

/** 月历格子比周条矮一档：省下来的正是「周几」那一行 */
export const GRID_CELL_MIN_HEIGHT = 48;

const WEEKDAY_HEADER = ['一', '二', '三', '四', '五', '六', '日'] as const;
/** 每行 7 个。写成常量是为了让「6 行」这件事在代码里看得见 */
const COLUMNS = 7;

export type CalendarPanelProps = {
  /** 显示哪个月，'2026-10' */
  month: string;
  /** 选中的那天 */
  selected: string;
  /** 时钟给的今天。用来看「回到今天」跳到哪、以及哪一格是今天 */
  today: string;
  /** 有任务的日子。查不到就是空的那天 */
  loads: Map<string, DayLoad>;
  onSelect: (day: string) => void;
  /** 翻月。给的是新月份的 1 号 */
  onMonthChange: (month: string) => void;
  /** 满格基准，必须和周条传同一个值 */
  fullAt?: number;
};

export function CalendarPanel({
  month,
  selected,
  today,
  loads,
  onSelect,
  onMonthChange,
  fullAt = LOAD_FULL_AT,
}: CalendarPanelProps) {
  const t = useTokens();

  const anchor = `${month}-01`;
  const days = monthGridDays(anchor);
  const rows = Array.from({ length: days.length / COLUMNS }, (_, r) => days.slice(r * COLUMNS, r * COLUMNS + COLUMNS));

  const shift = (delta: number) => {
    // 直接构造目标月份：`addMonths` 会把 31 号夹到月末，而我们只关心年月，
    // 从 1 号出发就不会被夹逼影响
    const [y, m] = month.split('-').map(Number) as [number, number];
    const total = y * 12 + (m - 1) + delta;
    const year = Math.floor(total / 12);
    const mon = (((total % 12) + 12) % 12) + 1;
    onMonthChange(`${String(year).padStart(4, '0')}-${String(mon).padStart(2, '0')}`);
  };

  const thisMonth = monthOf(today) === month;

  return (
    <View style={styles.panel}>
      {/* ── 翻月 ─────────────────────────────────────────── */}
      <View style={styles.nav}>
        {/* 箭头走 ChipAction：胶囊自己只有 30 高，而 hitSlop 会被父视图裁掉，
            所以触控区必须由外层撑到 44——那是「调整」按钮失效的同一个机制 */}
        <ChipAction label="‹" accessibilityLabel="上一个月" onPress={() => shift(-1)} />

        <AppText variant="subtitle" style={styles.monthLabel}>
          {monthLabel(anchor)}
        </AppText>

        <ChipAction label="›" accessibilityLabel="下一个月" onPress={() => shift(1)} />

        <View style={styles.spacer} />

        {/* 已经在今天这个月时退回中性描边：它仍然能点，但点了不会发生什么，
            所以不该继续亮着 */}
        <ChipAction
          label="回到今天"
          tone={thisMonth ? 'neutral' : 'accent'}
          onPress={() => onMonthChange(monthOf(today))}
        />
      </View>

      {/* ── 星期表头 ─────────────────────────────────────── */}
      <View style={styles.row}>
        {WEEKDAY_HEADER.map((w) => (
          <View key={w} style={styles.headerCell}>
            <AppText variant="caption" tone="textFaint">
              {w}
            </AppText>
          </View>
        ))}
      </View>

      {/* ── 6×7 ─────────────────────────────────────────── */}
      <View style={styles.grid}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map((day) => {
              const load = loads.get(day) ?? { day, minutes: 0, done: 0, total: 0, isToday: day === today };
              return (
                <DayCell
                  key={day}
                  load={load}
                  selected={day === selected}
                  muted={!inMonth(day, month)}
                  fullAt={fullAt}
                  onPress={() => onSelect(day)}
                  style={styles.gridCell}
                />
              );
            })}
          </View>
        ))}
      </View>

      <View style={[styles.legend, { borderTopColor: t.border }]}>
        <AppText variant="caption" tone="textFaint">
          灰字是上/下个月。负载条是当天的安排量，满格 {Math.round(fullAt / 60)} 小时。
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: space.sm,
  },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  monthLabel: {
    // 固定宽度会让「2026 年 10 月」和「2026 年 12 月」的 ‹ › 不跳位置
    minWidth: 96,
  },
  spacer: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    gap: space.xs,
  },
  headerCell: {
    flex: 1,
    alignItems: 'center',
    paddingBottom: space.xxs,
  },
  grid: {
    gap: space.xxs,
  },
  gridCell: {
    minHeight: GRID_CELL_MIN_HEIGHT,
  },
  legend: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.sm,
  },
});
