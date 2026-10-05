/**
 * 日历屏 —— 「整份计划排成什么样」的那一屏。
 *
 * ## 它和今日页的分工
 *
 * 今日页回答「我今天干什么」，日历回答「我这几周到底排成什么样、哪天压得太满」。
 * 所以这一屏的**视觉焦点是那张网格**（负载条是唯一的信息载体），
 * 下面的选中日任务列表是「点进去看看」的延续，并且**用的是同一张任务卡**
 * ——在日历里也能勾选、也能展开调整，不需要回到今日页。
 *
 * ## 为什么不把「没排期的任务」画进日历
 *
 * 日历的横轴是日期，待排池里的任务**没有日期**。把它们塞进某一天是在撒谎
 * （学生会以为系统替他排了）。所以它们只在底部用一行说明提一句，
 * 真正的家在今日页的待排池。
 *
 * ## 两处和今日页刻意不一样的地方
 *
 * 1. **选中日不由 `today` 驱动**。今日页有一条「`today` 一变就重置选中日」的
 *    effect——在那一屏是对的（跨天之后你当然想看今天）。但在这里，学生可能正
 *    翻看别的月份，调试模式下改一次日期就把他看的那天换掉，是「界面自己动了一下」。
 *    所以这一屏只在挂载时取一次 `today`。
 * 2. **点了外月的补格会连带翻月**。否则会出现「选中了 11 月 2 日、网格却是 10 月」
 *    这种自相矛盾的状态。
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { monthLabel, monthOf, inMonth } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { CalendarPanel } from '@/components/calendar-panel';
import { SectionHeader, ChipAction } from '@/components/card';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { NoticeBanner } from '@/components/notice-banner';
import { Screen } from '@/components/screen';
import { TaskList } from '@/components/task-list';
import { LOAD_FULL_AT, type DayLoad } from '@/components/day-cell';
import { fmtFull, fmtMinutes } from '@/lib/dates';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export default function CalendarScreen() {
  const router = useRouter();
  const { plan, today, notice, dismissNotice } = usePlanStore();

  /**
   * 选中日和月份用「学生挑过没有」来决定，而不是拿 `today` 初始化一次。
   *
   * 踩过的坑：最初写的是 `useState(today)`。**时钟是异步接上的**——
   * 首帧 `today` 还是设备日期，几百毫秒后才变成设置里的固定日期，
   * 而 `useState` 的初值只取一次。于是截图里出现了
   * 「网格上今天是 10/19，下面却写着 10月4日 周日 · 0 项」这种自相矛盾的画面。
   *
   * 为什么不用今日页那条「`today` 一变就重置」的 effect：
   * 在今日页是对的（跨天之后你当然想看今天），但在这里，学生可能正翻着别的月份，
   * 时钟一跳就把他看的那天换掉，读起来是「界面自己动了一下」。
   *
   * 所以：**没挑过就跟着时钟走，挑过之后就听学生的**。
   */
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  const selectedDay = pickedDay ?? today;
  const month = pickedMonth ?? monthOf(today);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const view = useMemo(() => {
    if (!plan) return null;

    const loads = new Map<string, DayLoad>();
    for (const tk of plan.tasks) {
      if (!tk.scheduledFor) continue;
      const cur = loads.get(tk.scheduledFor);
      if (cur) {
        cur.minutes += tk.estimateMin;
        cur.total += 1;
        if (tk.status === 'done') cur.done += 1;
      } else {
        loads.set(tk.scheduledFor, {
          day: tk.scheduledFor,
          minutes: tk.estimateMin,
          done: tk.status === 'done' ? 1 : 0,
          total: 1,
          isToday: tk.scheduledFor === today,
        });
      }
    }

    const inMonthTasks = plan.tasks.filter((tk) => tk.scheduledFor && inMonth(tk.scheduledFor, month));
    return {
      loads,
      monthTotal: inMonthTasks.length,
      monthMinutes: inMonthTasks.reduce((s, tk) => s + tk.estimateMin, 0),
      dayTasks: plan.tasks.filter((tk) => tk.scheduledFor === selectedDay),
      dayMinutes: plan.tasks
        .filter((tk) => tk.scheduledFor === selectedDay)
        .reduce((s, tk) => s + tk.estimateMin, 0),
      backlog: plan.tasks.filter((tk) => !tk.scheduledFor),
    };
  }, [plan, month, selectedDay, today]);

  /** 返回。日历是从今日页推进来的，所以退栈就是原路回去 */
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!plan || !view) {
    return (
      <Screen>
        <ScreenHeader title="日历" right={<HeaderAction label="返回" onPress={goBack} />} />
        <View style={{ paddingHorizontal: screenPadding }}>
          <AppText variant="body" tone="textMuted">
            计划还没读出来。
          </AppText>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title="日历"
        meta={`${monthLabel(`${month}-01`)} · 本月 ${view.monthTotal} 项${
          view.monthMinutes > 0 ? ` · ${fmtMinutes(view.monthMinutes)}` : ''
        }`}
        right={<HeaderAction label="返回" accessibilityLabel="回到今日页" onPress={goBack} />}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <NoticeBanner notice={notice} onDismiss={dismissNotice} />

        <CalendarPanel
          month={month}
          selected={selectedDay}
          today={today}
          loads={view.loads}
          fullAt={LOAD_FULL_AT}
          onMonthChange={setPickedMonth}
          onSelect={(day) => {
            setPickedDay(day);
            // 点到外月的补格就连带翻过去，否则「选中的日子」和「看到的月份」会打架
            if (!inMonth(day, month)) setPickedMonth(monthOf(day));
          }}
        />

        <View style={styles.section}>
          <SectionHeader
            right={
              <ChipAction
                label="+ 新任务"
                accessibilityLabel={`新加一项到${selectedDay === today ? '今天' : fmtFull(selectedDay)}`}
                onPress={() => router.push({ pathname: '/task/[id]', params: { id: 'new', day: selectedDay } })}
              />
            }
          >
            {selectedDay === today ? '今天' : fmtFull(selectedDay)} · {view.dayTasks.length} 项
            {view.dayMinutes > 0 ? ` · ${fmtMinutes(view.dayMinutes)}` : ''}
          </SectionHeader>

          <TaskList
            tasks={view.dayTasks}
            plan={plan}
            expandedId={expandedId}
            onToggleExpand={setExpandedId}
            onOpenEditor={(taskId) => router.push({ pathname: '/task/[id]', params: { id: taskId } })}
            empty={{
              glyph: '○',
              title: '这天没有安排',
              body: '点别的日子看看，或者回今日页从待排池挑一项放进来。',
            }}
          />
        </View>

        {view.backlog.length > 0 ? (
          <AppText variant="caption" tone="textFaint">
            还有 {view.backlog.length} 项没有排期，不在日历上——它们在今日页的待排池里。
          </AppText>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: screenPadding,
    paddingTop: space.lg,
    paddingBottom: space.xxxl,
    gap: space.xl,
  },
  section: {
    gap: space.md,
  },
});
