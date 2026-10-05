/**
 * 回归结账页 —— 学生隔了几天再打开时，把被时间冲掉的事实对齐。
 *
 * ## 这一屏为什么存在
 *
 * 计划是围绕着「你每天会做一点」设计的。学生一停就是五天时，纸面上什么都没变，
 * 但事实全变了：九项任务已经过期，其中两项还挡着后面的安排。
 * 一个不会发现这件事的系统，本质上只是一张打印出来的表格。
 *
 * ## 默认值是「都没做」
 *
 * 列表默认假定这段时间的任务**都没做**，学生只勾出他其实完成了的那几项。
 * 三条理由：它是**无损**的默认（任务不会丢，也不会被错误记账）；
 * 它让**最常见的情况是零次额外操作**；反过来「逐项问做了没」在隔了 5 天、
 * 9 项时会变成 9 次问答，和「简洁的交互」正面冲突。
 *
 * ## 一条命令，不是十二条
 *
 * 确认之后走的是**一条** `plan.settle`：一次版本 +1、一条历史、一个回滚点。
 * 十二项各发一条会得到十二个版本，历史变成一屏看不出这是一次结算的行，
 * 而且**一次回滚回不到整批之前**。
 *
 * ## 数字全部来自引擎
 *
 * `settleFacts` 算好之后才渲染；模型只被允许改写那一段叙述，而且服务端会拿
 * 白名单核对它写出的每一个整数（见 shared 的 `narrativeNumbersOk`）。
 * 「有 9 项没做」是这一屏唯一不能错的数字，而模型数数不可靠。
 */
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { SettleCarry } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { BottomBar, PrimaryButton } from '@/components/bottom-bar';
import { Card, SectionLabel } from '@/components/card';
import { CheckControl } from '@/components/check-control';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { ScrollBody } from '@/components/scroll-body';
import { fmtMinutes, fmtMonthDay } from '@/lib/dates';
import { animateNextLayout } from '@/lib/layout-animation';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

/** 那批没做的怎么办。顺序就是推荐顺序：第一个是默认 */
const CARRY_OPTIONS: { value: SettleCarry; title: string; body: string }[] = [
  {
    value: 'backlog',
    title: '放回待排池',
    body: '把它们从原来那几天拿下来，等你决定什么时候做。',
  },
  {
    value: 'compress',
    title: '压缩到接下来几天',
    body: '按你的可用时段重新挤进去。',
  },
  {
    value: 'hold',
    title: '先不动，我自己安排',
    body: '排期保持原样。适用「我就是要按原来的节奏补」。',
  },
];

export default function SettleScreen() {
  const router = useRouter();
  const { pendingSettle: facts, settle, dismissSettle, narrateSettle } = usePlanStore();

  /** 学生勾了「其实我做了」的 */
  const [done, setDone] = useState<Set<string>>(new Set());
  /** 学生勾了「放弃」的 */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [carry, setCarry] = useState<SettleCarry>('backlog');
  const [busy, setBusy] = useState(false);

  /**
   * 叙述。**先显示本机算出来的那版**，模型返回后再换上去。
   *
   * 和复盘页同一个理由：断网/超时时这一屏本来就有正确答案，
   * 让学生盯着空白等一个「更好的措辞」是本末倒置。
   */
  const [narrative, setNarrative] = useState<{ text: string; source: 'llm' | 'local' } | null>(null);
  useEffect(() => {
    if (!facts) return;
    let alive = true;
    void (async () => {
      const r = await narrateSettle(facts);
      if (alive) setNarrative({ text: r.narrative, source: r.source });
    })();
    return () => {
      alive = false;
    };
  }, [facts, narrateSettle]);

  const totals = useMemo(() => {
    if (!facts) return null;
    return {
      total: facts.pending.length,
      blocking: facts.pending.filter((p) => p.blocks > 0).length,
      minutes: facts.pending.reduce((s, p) => s + p.estimateMin, 0),
    };
  }, [facts]);

  if (!facts || !totals) {
    return (
      <Screen>
        <ScreenHeader title="结账" />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState glyph="✓" tone="success" title="没有要结的账" body="这段时间的任务都处理过了。" />
        </View>
      </Screen>
    );
  }

  /**
   * 一项只能处在「做完了 / 放弃 / 默认没做」三者之一。
   *
   * 先把它从另一组里摘掉，再在自己这组里翻转——两个集合同时命中一项的话，
   * `plan.settle` 里 `done` 优先，但界面上会显示成两个状态都亮着。
   */
  const toggle = (id: string, state: 'done' | 'skipped') => {
    const [self, selfSetter, other, otherSetter] =
      state === 'done'
        ? ([done, setDone, skipped, setSkipped] as const)
        : ([skipped, setSkipped, done, setDone] as const);

    if (other.has(id)) {
      const cleaned = new Set(other);
      cleaned.delete(id);
      otherSetter(cleaned);
    }
    const next = new Set(self);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    animateNextLayout();
    selfSetter(next);
  };

  const onConfirm = async () => {
    setBusy(true);
    await settle({ done: [...done], skipped: [...skipped], carry });
    setBusy(false);
    router.replace('/');
  };

  return (
    <Screen>
      <ScreenHeader
        title="结账"
        meta={`${fmtMonthDay(facts.from)} ~ ${fmtMonthDay(facts.to)} · ${facts.daysPassed} 天`}
        right={
          <HeaderAction
            label="以后再说"
            accessibilityLabel="先不结账"
            onPress={() => {
              dismissSettle();
              router.replace('/');
            }}
          />
        }
      />

      <ScrollBody
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── 发生了什么：本屏的视觉焦点 ─────────────────────── */}
        <Card tone="accent" bordered>
          <AppText variant="caption" tone="textMuted" style={styles.eyebrow}>
            {narrative?.source === 'llm' ? 'AI 综述' : narrative ? '系统综述' : '正在整理…'}
          </AppText>
          <AppText variant="body">{narrative?.text ?? `距上次打开过了 ${facts.daysPassed} 天。`}</AppText>
        </Card>

        {/* 关键数字直接摆出来。这段话和下面那张清单必须是同一批数字 */}
        <View style={styles.chipRow}>
          <Chip tone="warning">{totals.total} 项没打勾</Chip>
          {totals.blocking > 0 ? <Chip tone="warning">{totals.blocking} 项挡着后续</Chip> : null}
          <Chip tone="neutral">{fmtMinutes(totals.minutes)}</Chip>
          {facts.doneCount > 0 ? <Chip tone="success">已完成 {facts.doneCount} 项</Chip> : null}
        </View>

        {facts.pastGoalDeadline ? (
          <Card bordered style={styles.stack}>
            <AppText variant="label" tone="warning">
              目标的截止日已经过去了。
            </AppText>
            <AppText variant="caption" tone="textFaint">
              这件事不在这张页面能处理的范围里——要不要改目标，你可以在复盘里决定。
            </AppText>
          </Card>
        ) : null}

        {/* ── 这 N 项，实际情况是 ───────────────────────────── */}
        <View style={styles.section}>
          <SectionLabel>这 {totals.total} 项，实际情况是</SectionLabel>
          <AppText variant="caption" tone="textFaint">
            默认按「都没做」算。你只需要勾出其实做完的，或者明确放弃的。
          </AppText>

          <View style={styles.list}>
            {facts.pending.map((p) => {
              const isDone = done.has(p.taskId);
              const isSkipped = skipped.has(p.taskId);
              return (
                <Card key={p.taskId} tone={isDone || isSkipped ? 'sunken' : 'surface'} bordered>
                  <View style={styles.itemHead}>
                    <AppText
                      variant="subtitle"
                      tone={isDone || isSkipped ? 'textFaint' : 'text'}
                      style={styles.itemTitle}
                    >
                      {p.title}
                    </AppText>
                    <CheckControl
                      checked={isDone}
                      label={isDone ? '做完了' : '标记做完'}
                      accessibilityLabel={`把「${p.title}」标记为做完了`}
                      onToggle={() => toggle(p.taskId, 'done')}
                    />
                  </View>

                  <View style={styles.chipRow}>
                    <Chip tone="neutral">原定 {fmtMonthDay(p.scheduledFor)}</Chip>
                    <Chip tone="neutral">{fmtMinutes(p.estimateMin)}</Chip>
                    {/* 「卡住后续 N 项」而不是「挡着 N 项」：上面那排汇总胶囊用的是
                        「N 项挡着后续」表示**有几项在挡人**，这里说的是**这一项卡住几项**。
                        两个数字含义不同而措辞太像，学生会以为页面自相矛盾 */}
                    {p.blocks > 0 ? <Chip tone="warning">卡住后续 {p.blocks} 项</Chip> : null}
                  </View>

                  {/* 用胶囊而不是一行淡色小字：这个操作和任务卡上那个「调整」踩过同一个坑——
                      一个小字号的浅色文本既看不出能点，触控区也远小于 44 */}
                  <View style={styles.chipRow}>
                    <Chip
                      tone={isSkipped ? 'warning' : 'neutral'}
                      selected={isSkipped}
                      accessibilityLabel={isSkipped ? `取消放弃「${p.title}」` : `放弃「${p.title}」`}
                      onPress={() => toggle(p.taskId, 'skipped')}
                    >
                      {isSkipped ? '已放弃 · 点一下取消' : '这一项我不做了'}
                    </Chip>
                  </View>
                </Card>
              );
            })}
          </View>
        </View>

        {/* ── 接下来怎么办 ─────────────────────────────────── */}
        <View style={styles.section}>
          <SectionLabel>接下来怎么办</SectionLabel>
          <View style={styles.list}>
            {CARRY_OPTIONS.map((o) => {
              const selected = carry === o.value;
              const overload = o.value === 'compress' && facts.compress.overloaded;
              return (
                <Card key={o.value} tone={selected ? 'accent' : 'surface'} bordered style={styles.option}>
                  <AppText
                    variant="label"
                    tone={selected ? 'primary' : 'text'}
                    accessibilityRole="button"
                    accessibilityLabel={`${o.title}${selected ? '（已选）' : ''}`}
                    onPress={() => setCarry(o.value)}
                    suppressHighlighting
                  >
                    {selected ? '● ' : '○ '}
                    {o.title}
                  </AppText>
                  <AppText variant="caption" tone="textMuted">
                    {o.body}
                    {o.value === 'compress' ? `接下来的 ${facts.compress.horizonDays} 天。` : ''}
                  </AppText>
                  {overload ? (
                    // 超载要如实说。压缩是个诱人的选项，但装不下的时候
                    // 它会排出一个人根本做不完的表——那比不排更糟
                    <AppText variant="caption" tone="warning">
                      按你的可用时段放不下（{fmtMinutes(facts.compress.minutes)} 对{' '}
                      {fmtMinutes(facts.compress.capacity)}），会有一部分留在待排池。
                    </AppText>
                  ) : null}
                </Card>
              );
            })}
          </View>
        </View>
      </ScrollBody>

      <BottomBar bottomInset={0}>
        <View style={styles.countBox}>
          {/*
            没勾任何东西时说清楚「确认」意味着什么。

            这一屏的默认值是「都没做」，而那是**看不见**的——学生看到
            「0 做完 · 0 放弃」时的合理反应是「那我按确认是干嘛？」。
            默认值必须被说出来，否则他会以为自己漏了一步。
          */}
          <AppText variant="caption" tone="textFaint">
            {done.size + skipped.size ? '已勾选' : '确认就按'}
          </AppText>
          <AppText variant="subtitle">
            {done.size + skipped.size ? `${done.size} 做完 · ${skipped.size} 放弃` : `这 ${totals.total} 项都没做`}
          </AppText>
        </View>
        <PrimaryButton label={busy ? '结账中…' : '确认'} disabled={busy} onPress={() => void onConfirm()} />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: screenPadding,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    gap: space.xl,
  },
  eyebrow: {
    letterSpacing: 0.6,
  },
  section: {
    gap: space.md,
  },
  list: {
    gap: space.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  stack: {
    gap: space.sm,
  },
  itemHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  itemTitle: {
    flex: 1,
  },
  option: {
    gap: space.xs,
  },
  countBox: {
    flex: 1,
  },
});
