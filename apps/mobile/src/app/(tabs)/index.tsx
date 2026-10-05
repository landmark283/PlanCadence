/**
 * 今日 / 计划主页 —— 学生待最久的一屏。
 *
 * 结构：目标（学生原话）→ 本周负载 → 选中那天的任务 → 待排池。
 *
 * 关于「目标卡为什么不用主色」：`color-limit-accents` 要求一屏最多一个强调色。
 * 这一屏的焦点应该是**任务列表**（学生是来干活的），目标只是上下文。
 * 所以目标卡走中性面，把主色留给进度条和「选中日」——两处都表示「当前状态」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Task } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card, SectionHeader, ChipAction } from '@/components/card';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { NoticeBanner } from '@/components/notice-banner';
import { PlanWarnings } from '@/components/plan-warnings';
import { ProgressBar } from '@/components/progress-bar';
import { ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { ReviewEntry } from '@/components/review-entry';
import { ScrollBody } from '@/components/scroll-body';
import { TalkEntry } from '@/components/talk-entry';
import { TaskList } from '@/components/task-list';
import { WeekStrip, type WeekStripDay } from '@/components/week-strip';
import { fmtFull, fmtMinutes, fmtMonthDay, startOfWeek, weekDays } from '@/lib/dates';
import { useCountUp } from '@/hooks/use-count-up';
import { screenPadding, space, touchTarget } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export default function TodayScreen() {
  const router = useRouter();
  const { plan, loadError, notice, dismissNotice, today, pendingSettle, undoSnapshot, undoLastApply } =
    usePlanStore();
  const [selectedDay, setSelectedDay] = useState(today);
  /** 同时只展开一张卡：展开多张之后，一屏又变回按钮墙 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * 隔了几天没打开的补账。
   *
   * 自动进结账页，因为**这件事只有学生本人能回答**——那几项到底做了没。
   *
   * 记的是**上一次弹的是哪一份事实**，而不是一个「弹过了」的布尔量：
   * 一次会话里可能弹两次（学生在文件页点了「模拟隔了 5 天回来」再点一次），
   * 用布尔量的话第二次就不会导航，看起来就像按钮坏了。
   * `settleFacts` 每次都返回新对象，所以按对象身份比较正好。
   */
  const promptedFor = useRef<unknown>(null);
  useEffect(() => {
    if (!pendingSettle || promptedFor.current === pendingSettle) return;
    promptedFor.current = pendingSettle;
    router.push('/settle');
  }, [pendingSettle, router]);

  /** 选中那天。日期一变（调试模式改日期、跨天）就跟着回到今天 */
  useEffect(() => {
    setSelectedDay(today);
  }, [today]);

  const view = useMemo(() => {
    if (!plan) return null;

    const days = weekDays(startOfWeek(today));
    const byDay = new Map<string, Task[]>();
    for (const tk of plan.tasks) {
      if (!tk.scheduledFor) continue;
      const bucket = byDay.get(tk.scheduledFor);
      if (bucket) bucket.push(tk);
      else byDay.set(tk.scheduledFor, [tk]);
    }
    const on = (d: string) => byDay.get(d) ?? [];
    const minutesOn = (d: string) => on(d).reduce((s, x) => s + x.estimateMin, 0);

    const weekTasks = days.flatMap(on);
    const weekDone = weekTasks.filter((x) => x.status === 'done');
    // 完成量优先用学生填的 actualMin，没有才退回预估——复盘页的偏差检测也是这个口径
    const spentMin = weekDone.reduce((s, x) => s + (x.actualMin ?? x.estimateMin), 0);

    return {
      days,
      on,
      minutesOn,
      strip: days.map<WeekStripDay>((d) => ({
        day: d,
        minutes: minutesOn(d),
        done: on(d).filter((x) => x.status === 'done').length,
        total: on(d).length,
        isToday: d === today,
      })),
      weekTotal: weekTasks.length,
      weekDoneCount: weekDone.length,
      spentMin,
      backlog: plan.tasks.filter((x) => !x.scheduledFor),
    };
  }, [plan, today]);

  /**
   * 完成数和已投入分钟数滚动。
   *
   * 必须在下面那个提前 return **之前**调用——hook 不能放在条件分支后面。
   * 传 `?? 0` 而不是跳过：计划还没有时它们本来就该是 0。
   */
  const doneShown = useCountUp(view?.weekDoneCount ?? 0);
  const spentShown = useCountUp(view?.spentMin ?? 0);

  if (!plan || !view) {
    return (
      <Screen>
        <ScreenHeader title="今日" />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState
            glyph="!"
            title={loadError?.kind === 'io' ? '存储不可用' : '计划文件读取失败'}
            body={loadError?.message ?? '未知错误'}
          />
        </View>
      </Screen>
    );
  }

  const { goal, constraints } = plan;
  const dayTasks = view.on(selectedDay);
  const budget = constraints.weeklyMinutes;
  /** 还在跑的线有几条（已收尾的不算——「目标 5」里有 3 条做完了没有信息量） */
  const milestoneCount = plan.milestones.filter((m) => m.status !== 'done' && m.status !== 'dropped').length;

  return (
    <Screen>
      <ScreenHeader
        title="今日"
        meta={`${fmtFull(today)} · 计划 v${plan.version}`}
        /**
         * 右上角是**复盘**——它是这一屏唯一的「想干什么」动作。
         *
         * 「重做访谈」原来占着这个位置，而它其实是个演示/开发动作
         * （学生不会想重做一遍访谈），已经挪到文件页的「演示用」区了。
         *
         * 复盘入口刻意用一个独立组件：**位置可能随时要改**，
         * 换地方应该是一处改动。
         */
        right={<ReviewEntry />}
      />

      <ScrollBody
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── 目标：学生原话，不改写 ───────────────────────── */}
        <Card style={styles.goalCard}>
          <View style={styles.goalHead}>
            <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
              我的目标
            </AppText>
            {/*
              「几条线」的入口。和「本周安排 ·〔日历〕」同一个模式：一屏放不下的东西
              进独立一屏，这里只留一个带**条数**的动作位。
              条数是刻意的——「目标 3」本身就是今日页需要的那点信息量，
              它同时告诉你「这个计划不止一条线」。
            */}
            <ChipAction
              label={milestoneCount ? `目标 ${milestoneCount}` : '目标'}
              accessibilityLabel={`打开目标清单，现在有 ${milestoneCount} 条线`}
              onPress={() => router.push('/goals')}
            />
          </View>
          <AppText variant="subtitle">{goal.statement}</AppText>

          <View style={styles.progressBlock}>
            <ProgressBar value={budget ? view.spentMin / budget : 0} />
            <View style={styles.progressMeta}>
              <AppText variant="label" tone="textMuted">
                本周 {doneShown}/{view.weekTotal} 项 · {spentShown}/{budget} 分钟
              </AppText>
              {goal.deadline ? (
                <AppText variant="label" tone="textFaint">
                  截止 {fmtMonthDay(goal.deadline)}
                </AppText>
              ) : null}
            </View>
          </View>

          {/* 不可用日期必须显式出现：学生设了它，就要能看见系统记得 */}
          {constraints.blackouts.length > 0 ? (
            <View style={styles.chipRow}>
              {constraints.blackouts.map((b) => (
                <Chip key={`${b.from}-${b.to}`} tone="warning">
                  {fmtMonthDay(b.from)}–{fmtMonthDay(b.to)} {b.reason ?? '不可用'}
                </Chip>
              ))}
            </View>
          ) : null}
        </Card>

        <NoticeBanner
          notice={notice}
          onDismiss={dismissNotice}
          // 只有「刚应用过一次会话」时才有值；学生一动别的东西它就没了
          onUndo={undoSnapshot ? undoLastApply : undefined}
        />

        {/*
          规划相关的提醒：计划自己和自己打架的地方（排期越界、超预算、前置倒挂……）。
          和复盘页用的是**同一个组件**，所以两处说法一字不差。
          它有独立的数据来源（`validatePlan` 现算），不依赖上面的通知条。
        */}
        <PlanWarnings plan={plan} />

        {/* ── 本周负载 ─────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader
            right={
              <ChipAction
                label="日历"
                accessibilityLabel="打开日历，看整个月的安排"
                onPress={() => router.push('/calendar')}
              />
            }
          >
            本周安排 · 点日期切换
          </SectionHeader>
          <WeekStrip days={view.strip} selected={selectedDay} onSelect={setSelectedDay} />
        </View>

        {/* ── 选中那天 ─────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader
            right={
              <ChipAction
                label="+ 新任务"
                accessibilityLabel={`新加一项到${selectedDay === today ? '今天' : fmtFull(selectedDay)}`}
                // 从哪天点进来就默认排到哪天——学生的心智是「给这天加一件事」
                onPress={() => router.push({ pathname: '/task/[id]', params: { id: 'new', day: selectedDay } })}
              />
            }
          >
            {selectedDay === today ? '今天' : fmtFull(selectedDay)} · {dayTasks.length} 项
            {view.minutesOn(selectedDay) > 0 ? ` · ${fmtMinutes(view.minutesOn(selectedDay))}` : ''}
          </SectionHeader>

          <TaskList
            tasks={dayTasks}
            plan={plan}
            expandedId={expandedId}
            onToggleExpand={setExpandedId}
            onOpenEditor={(taskId) => router.push({ pathname: '/task/[id]', params: { id: taskId } })}
            empty={{
              glyph: '○',
              title: selectedDay === today ? '今天没有安排' : '这天没有安排',
              body: '可以从下面的待排池挑一项放进来，或者就按现在的节奏休息。',
            }}
          />
        </View>

        {/* ── 待排池 ───────────────────────────────────────── */}
        {view.backlog.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader>待排 · {view.backlog.length} 项</SectionHeader>
            <TaskList
              tasks={view.backlog}
              plan={plan}
              variant="backlog"
              expandedId={expandedId}
              onToggleExpand={setExpandedId}
              onOpenEditor={(taskId) => router.push({ pathname: '/task/[id]', params: { id: taskId } })}
            />
          </View>
        ) : null}
      </ScrollBody>

      {/* 常驻入口：说一句话改计划。它浮在内容上，所以滚动区底部留了它的高度 */}
      <TalkEntry />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: screenPadding,
    paddingTop: space.lg,
    // 底部不再加安全区：tab bar 在下面，安全区已由它消费
    // 但要给浮在右下角的〔跟 AI 说说〕留出高度，否则它会盖住最后一张卡
    paddingBottom: space.xxxl + space.xxl,
    gap: space.xl,
  },

  goalCard: {
    gap: space.md,
  },
  goalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    // 动作位要 44，这一行跟着长高，否则 hitSlop 会被这行的边界裁掉
    minHeight: touchTarget,
  },
  eyebrow: {
    letterSpacing: 0.6,
  },
  progressBlock: {
    gap: space.sm,
  },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },

  section: {
    gap: space.md,
  },
  list: {
    gap: space.sm,
  },
});
