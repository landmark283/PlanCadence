/**
 * 目标屏 —— 「我现在在追几条线、哪条要紧」。
 *
 * ## 它和今日页的分工
 *
 * 今日页回答「我今天干什么」。目标屏回答「我在追哪几条线、各自到哪天、哪条来不及」。
 * 所以**卡片放这里而不是堆在今日页**：N 张目标卡竖排会把今天该做的任务推到屏幕外，
 * 而学生打开 App 十有八九是来干活的，不是来盘点的。
 * 入口放在今日页那句总目标的右上角（和「本周安排 ·〔日历〕」同一个模式），
 * 并且**带上条数**——「目标 3」本身就是今日页需要的那点信息量。
 *
 * ## 为什么这一屏不显示日历
 *
 * 复盘页的「现在的安排」里已经有一份日历，而且那一屏的任务是「看看这周排成什么样」。
 * 这里要回答的是「线」，日历塞进来会让两张卡之间的对照关系散掉。
 * 真要按线看排期，展开每张卡就能看到它自己的排期区间。
 *
 * ## 总目标那句话不在这里重复
 *
 * `plan.goal.statement` 是学生原话，它留在今日页。这一屏是**几条线**，
 * 两者不是一回事：一个是「我想要什么」，一个是「我为此开了哪几条战线」。
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { detectDrift, goalProgress, unassignedTasks } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { GoalCard } from '@/components/goal-card';
import { NoticeBanner } from '@/components/notice-banner';
import { PlanWarnings } from '@/components/plan-warnings';
import { ScreenHeader, HeaderAction } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { ScrollBody } from '@/components/scroll-body';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export default function GoalsScreen() {
  const router = useRouter();
  const { plan, today, notice, dismissNotice } = usePlanStore();
  /** 同时只展开一张：展开多张之后这一屏又变回一堵墙 */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const view = useMemo(() => {
    if (!plan) return null;
    const drift = detectDrift(plan, today);
    return {
      goals: goalProgress(plan, today, drift),
      loose: unassignedTasks(plan),
      atRisk: drift.filter((d) => d.kind === 'milestoneRisk').length,
    };
  }, [plan, today]);

  /** 返回。这一屏是从今日页推进来的，所以退栈就是原路回去 */
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!plan || !view) {
    return (
      <Screen>
        <ScreenHeader title="目标" right={<HeaderAction label="返回" onPress={goBack} />} />
        <View style={{ paddingHorizontal: screenPadding }}>
          <AppText variant="body" tone="textMuted">
            计划还没读出来。
          </AppText>
        </View>
      </Screen>
    );
  }

  const running = view.goals.filter((g) => g.status !== 'done' && g.status !== 'dropped');

  return (
    <Screen>
      <ScreenHeader
        title="目标"
        meta={
          view.goals.length
            ? `${running.length} 条在跑 · 共 ${view.goals.length} 条${view.atRisk ? ` · ${view.atRisk} 条来不及` : ''}`
            : '还没有立过目标'
        }
        right={<HeaderAction label="返回" accessibilityLabel="回到今日页" onPress={goBack} />}
      />

      <ScrollBody
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <NoticeBanner notice={notice} onDismiss={dismissNotice} />

        {view.goals.length ? (
          <View style={styles.list}>
            {view.goals.map((g) => (
              <GoalCard
                key={g.milestoneId}
                goal={g}
                expanded={expandedId === g.milestoneId}
                onToggle={() => setExpandedId((cur) => (cur === g.milestoneId ? null : g.milestoneId))}
              />
            ))}
          </View>
        ) : (
          <EmptyState
            glyph="◇"
            title="还没有立过目标"
            body="跟 AI 说一句「帮我加一条线：……」就会有第一条了。"
          />
        )}

        {/*
          不属于任何一条线的任务必须说出来。
          否则学生把卡片上的项数加起来，会发现比计划里的总数少，
          而少掉的那些在这一屏上无迹可寻——「数字对不上又找不到原因」最容易让人不信这个界面。
        */}
        {view.loose.length ? (
          <Card bordered style={styles.loose}>
            <AppText variant="label" tone="textMuted">
              还有 {view.loose.length} 项没有归到任何目标上
            </AppText>
            <AppText variant="caption" tone="textFaint">
              {view.loose
                .slice(0, 3)
                .map((t) => t.title)
                .join('、')}
              {view.loose.length > 3 ? ` 等 ${view.loose.length} 项` : ''}
              。它们在今日页的待排池或各自那天的安排里，只是不参与上面任何一条线的进度。
            </AppText>
          </Card>
        ) : null}

        {/* 计划自己和自己打架的地方（排期越界、超预算……），和今日页、复盘页同一份实现 */}
        <PlanWarnings plan={plan} />
      </ScrollBody>
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
  list: {
    gap: space.md,
  },
  loose: {
    gap: space.sm,
  },
});
