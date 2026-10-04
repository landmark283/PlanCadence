/**
 * 今日 / 计划主页 —— 学生待最久的一屏。
 *
 * 结构：目标（学生原话）→ 本周负载 → 选中那天的任务 → 待排池。
 *
 * 关于「目标卡为什么不用主色」：`color-limit-accents` 要求一屏最多一个强调色。
 * 这一屏的焦点应该是**任务列表**（学生是来干活的），目标只是上下文。
 * 所以目标卡走中性面，把主色留给进度条和「选中日」——两处都表示「当前状态」。
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Task } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card, SectionLabel } from '@/components/card';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { NoticeBanner } from '@/components/notice-banner';
import { ProgressBar } from '@/components/progress-bar';
import { ScreenHeader, HeaderAction } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { TaskCard } from '@/components/task-card';
import { WeekStrip, type WeekStripDay } from '@/components/week-strip';
import { fmtFull, fmtMinutes, fmtMonthDay, startOfWeek, weekDays } from '@/lib/dates';
import { animateNextLayout } from '@/lib/layout-animation';
import { useCountUp } from '@/hooks/use-count-up';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export default function TodayScreen() {
  const router = useRouter();
  const { plan, loadError, notice, dismissNotice, apply, today } = usePlanStore();
  const [selectedDay, setSelectedDay] = useState(today);
  /** 同时只展开一张卡：展开多张之后，一屏又变回按钮墙 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      byId: new Map(plan.tasks.map((x) => [x.id, x])),
      /** 资源 id → 资源。任务卡上要显示挂着的那几条 */
      resourceById: new Map(plan.resources.map((r) => [r.id, r])),
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

  /**
   * 所有会改动排期的命令都从这里走。
   *
   * 改预估或改状态都可能让引擎把任务挪到别的日子——那时卡片会从当前列表里
   * 消失、后面的卡片往上补位。不做动画的话这一步是「啪」地跳一下，
   * 而「系统自动重排」恰恰是我们要让学生看见的事。
   * 纯原生动效（web 上是空操作），理由见 lib/layout-animation.ts
   */
  const applyRescheduling = (cmd: Parameters<typeof apply>[0]) => {
    animateNextLayout();
    apply(cmd);
  };

  /**
   * 任务卡的统一渲染。
   *
   * 已排期和待排池两处共用，避免「改了其中一处、另一处忘了改」——
   * 之前就出现过两段几乎一样的 15 行 JSX。
   */
  const renderTask = (tk: Task, variant: 'scheduled' | 'backlog' = 'scheduled') => (
    <TaskCard
      key={tk.id}
      task={tk}
      variant={variant}
      // 挂在这条任务上的资料。id 找不到的静默跳过——资源可能被删了，
      // 而这不该让整张卡炸掉
      resources={tk.resourceIds.flatMap((rid) => {
        const r = view.resourceById.get(rid);
        return r ? [r] : [];
      })}
      deps={
        variant === 'backlog'
          ? []
          : tk.dependsOn.flatMap((id) => {
              const d = view.byId.get(id);
              return d ? [{ id: d.id, title: d.title, done: d.status === 'done' }] : [];
            })
      }
      expanded={expandedId === tk.id}
      onToggleExpand={() => setExpandedId((cur) => (cur === tk.id ? null : tk.id))}
      onToggleDone={() => {
        const next = tk.status === 'done' ? 'todo' : 'done';
        applyRescheduling({ type: 'task.setStatus', taskId: tk.id, status: next });
        // 刚打勾时顺手把卡展开：紧接着要问「实际用了多久」，
        // 而那是引擎判断超前/落后的唯一输入
        setExpandedId(next === 'done' ? tk.id : null);
      }}
      onSetStatus={(status) => applyRescheduling({ type: 'task.setStatus', taskId: tk.id, status })}
      onSetEstimate={(estimateMin) => applyRescheduling({ type: 'task.setEstimate', taskId: tk.id, estimateMin })}
      onSetActual={(actualMin) => applyRescheduling({ type: 'task.setStatus', taskId: tk.id, status: 'done', actualMin })}
    />
  );

  return (
    <Screen>
      <ScreenHeader
        title="今日"
        meta={`${fmtFull(today)} · 计划 v${plan.version}`}
        right={
          <HeaderAction
            label="重做访谈"
            accessibilityLabel="重新做一次访谈"
            onPress={() => router.push('/onboarding')}
          />
        }
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── 目标：学生原话，不改写 ───────────────────────── */}
        <Card style={styles.goalCard}>
          <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
            我的目标
          </AppText>
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

        <NoticeBanner notice={notice} onDismiss={dismissNotice} />

        {/* ── 本周负载 ─────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionLabel>本周安排 · 点日期切换</SectionLabel>
          <WeekStrip days={view.strip} selected={selectedDay} onSelect={setSelectedDay} />
        </View>

        {/* ── 选中那天 ─────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionLabel>
            {selectedDay === today ? '今天' : fmtFull(selectedDay)} · {dayTasks.length} 项
            {view.minutesOn(selectedDay) > 0 ? ` · ${fmtMinutes(view.minutesOn(selectedDay))}` : ''}
          </SectionLabel>

          {dayTasks.length === 0 ? (
            <EmptyState
              glyph="○"
              title={selectedDay === today ? '今天没有安排' : '这天没有安排'}
              body="可以从下面的待排池挑一项放进来，或者就按现在的节奏休息。"
            />
          ) : (
            <View style={styles.list}>{dayTasks.map((tk) => renderTask(tk))}</View>
          )}
        </View>

        {/* ── 待排池 ───────────────────────────────────────── */}
        {view.backlog.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>待排 · {view.backlog.length} 项</SectionLabel>
            <View style={styles.list}>{view.backlog.map((tk) => renderTask(tk, 'backlog'))}</View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: screenPadding,
    paddingTop: space.lg,
    // 底部不再加安全区：tab bar 在下面，安全区已由它消费
    paddingBottom: space.xxxl,
    gap: space.xl,
  },

  goalCard: {
    gap: space.md,
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
