/**
 * 资源 / 情报面板。
 *
 * 三件事：
 *  1. 让学生相信「这些资料是真的、是刚查的」——每张卡都带校验时间与来源，
 *     赛事还要有倒计时
 *  2. 让「系统主动去找」这件事**可见**：一个按钮，跑完告诉你它按什么词找的、
 *     拿到了几条、有没有拿到实时赛程
 *  3. 赛事单独成区、排在最前：情报面板里唯一「过期就作废」的东西就是它，
 *     混在资料列表里会被淹没
 *
 * ## 这一页为什么必须显示「按什么找的」
 *
 * 一条查不到来源的资源，和一个模型编出来的链接，在界面上长得一模一样。
 * 把检索用的关键词亮出来，学生就能自己判断「它是不是按我说的在找」——
 * 这一步的可信度，比多给两条资源重要。
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Card, SectionLabel } from '@/components/card';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { ScrollBody } from '@/components/scroll-body';
import { provenanceLine, ResourceCard } from '@/components/resource-card';
import { ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { attachResources } from '@/lib/api';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export default function ResourcesScreen() {
  const { plan, today, profile, apply, notify } = usePlanStore();
  const [busy, setBusy] = useState(false);

  /**
   * 主动检索。
   *
   * 结果不是直接改 state，而是包成一条 `plan.attachResources` 命令交给 store——
   * 铁律：任何计划变更都必须走 `applyCommand`，否则历史、版本、校验全会漏掉。
   */
  const findResources = async () => {
    if (!plan || busy) return;
    setBusy(true);
    notify({ tone: 'success', text: '正在检索资料…' });

    const res = await attachResources(plan, profile, today);
    setBusy(false);

    if (!res.ok) {
      notify({ tone: 'error', text: `找资料失败：${res.error}` });
      return;
    }

    const { resources, links, queries, live, note } = res.value;
    if (!resources.length && !links.length) {
      // 这不是错误，是「已经是最新的了」。用 error 语气说会让人以为坏了
      notify({ tone: 'success', text: '计划里的资料已经是最新的一批，这次没有新增' });
      return;
    }

    apply({ type: 'plan.attachResources', resources, links });

    /**
     * 命令自己的摘要是「检索到 N 条资料，挂到 M 个任务上」，
     * 但没说你**按什么**找的、有没有拿到实时数据。这两件事恰恰是
     * 「主动获取」的可信度所在，所以再补一条更完整的。
     * 两条 notice 同一批更新，只有后者会被看到。
     */
    const bits = [`按「${queries.slice(0, 3).join('、')}」检索到 ${resources.length} 条`];
    if (links.length) bits.push(`挂到 ${links.length} 个任务`);
    bits.push(live ? '含实时赛程' : note.slice(0, 50));
    notify({ tone: 'success', text: bits.join(' · ') });
  };

  if (!plan) {
    return (
      <Screen>
        <ScreenHeader title="资源" />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState glyph="!" title="计划文件读取失败" body="无法读取计划，请检查存储权限。" />
        </View>
      </Screen>
    );
  }

  const contests = plan.resources.filter((r) => r.kind === 'contest');
  const materials = plan.resources.filter((r) => r.kind !== 'contest');
  /**
   * 实时抓回来的那批。
   *
   * 判据用的是卡片自己的 `provenanceLine`，不在这里另写一套——
   * 「什么算实时」只能有一处定义，否则脚注和卡片迟早会各说各的。
   */
  const liveCount = plan.resources.filter((r) => provenanceLine(r, today).live).length;

  // 最近一次校验：作为副标题，一眼说明「这批信息有多新」
  const latest = plan.resources
    .map((r) => r.verifiedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);

  return (
    <Screen>
      <ScreenHeader
        title="资源"
        meta={`${plan.resources.length} 条${latest ? ` · 最近校验 ${latest.slice(0, 10)}` : ''}`}
      />

      <ScrollBody contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 主动获取的入口。放在最上面：这一页的价值就是「它真的去查了」 */}
        <Card bordered style={styles.stack}>
          <AppText variant="label" tone="textMuted">
            让系统按这份计划的内容去查一遍资料，查到什么就挂到对应的任务上。
          </AppText>
          <View style={styles.actionRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="按计划内容检索资料"
              accessibilityState={{ busy }}
              disabled={busy}
              onPress={() => void findResources()}
              style={({ pressed }) => [styles.action, pressed || busy ? styles.pressed : null]}
            >
              <AppText variant="label" tone="primary">
                {busy ? '正在检索…' : '按计划内容找资料'}
              </AppText>
            </Pressable>
          </View>
          <AppText variant="caption" tone="textFaint">
            资料来自内置的、网址逐条核过的资料库；赛事日程在能联网时实时抓取。
            抓不到实时数据时只给官网入口——不会给你一个猜的截止日。
          </AppText>
        </Card>

        {plan.resources.length === 0 ? (
          <EmptyState
            glyph="○"
            title="还没有资源"
            body="点上面的「按计划内容找资料」，或者做一次访谈——生成计划时会一并带上。"
          />
        ) : null}

        {contests.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>赛事与截止 · {contests.length} 项</SectionLabel>
            <View style={styles.list}>
              {contests.map((r) => (
                <ResourceCard key={r.id} resource={r} today={today} />
              ))}
            </View>
          </View>
        ) : null}

        {materials.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>学习资料 · {materials.length} 条</SectionLabel>
            <View style={styles.list}>
              {materials.map((r) => (
                <ResourceCard key={r.id} resource={r} today={today} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.footnote}>
          {liveCount > 0 ? (
            <View style={styles.liveRow}>
              <Chip tone="accent">实时抓取 {liveCount} 条</Chip>
            </View>
          ) : null}
          <AppText variant="caption" tone="textFaint">
            每条资源下面那行小字是判断它可信度的唯一依据：
            标「实时」的是刚抓回来的，标「资料库快照」的是人工核对过的固定清单。
          </AppText>
        </View>
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
  section: {
    gap: space.md,
  },
  list: {
    gap: space.sm,
  },
  stack: {
    gap: space.md,
  },
  actionRow: {
    flexDirection: 'row',
  },
  action: {
    paddingVertical: space.md,
  },
  pressed: {
    opacity: 0.6,
  },
  footnote: {
    marginTop: space.sm,
    gap: space.sm,
  },
  liveRow: {
    flexDirection: 'row',
  },
});
