/**
 * 复盘协商页 —— 演示的主高潮（演示脚本 2:10–2:40）。
 *
 * 数据仍然在**本机**算（`reviewPlan` → `engineView`），不依赖服务端：
 * 断网时 App 本来就应该能用本机逻辑完成复盘，这是设计的降级路径。
 * 接上服务端后把 `view` 换成 `/plan/review` 的返回值即可，
 * 组件一个都不用改——因为契约是同一个 `AdvisorView`。
 *
 * 「应用调整」这次是**真的**写回计划（走 `plan.applyAdjustments`）：
 * 版本号 +1、history 追加一条、引擎随即基于新排期重算。
 * 之前这一屏的按钮是个空壳，点下去没反应。
 */
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  engineView,
  reviewPlan,
  serializePlan,
  validatePlan,
  type AdvisorAdjustmentView,
  type AdvisorView,
  type Drift,
} from '@sp/shared';

import { AppText } from '@/components/app-text';
import { BottomBar, PrimaryButton } from '@/components/bottom-bar';
import { Card, SectionLabel } from '@/components/card';
import { CheckControl } from '@/components/check-control';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { StatRow } from '@/components/stat-row';
import { fmtMonthDay } from '@/lib/dates';
import { fetchReview } from '@/lib/api';
import { screenPadding, space, useTokens } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

function moveLabel(a: AdvisorAdjustmentView): string {
  if (a.from === a.to) return '不改期';
  if (!a.to) return `${a.from ? fmtMonthDay(a.from) : '待排'} → 移回待排池`;
  if (!a.from) return `未安排 → ${fmtMonthDay(a.to)}`;
  return `${fmtMonthDay(a.from)} → ${fmtMonthDay(a.to)}`;
}

/**
 * 偏差压成短标签。
 *
 * 直接说「1 项耗时超预估」而不是「overrun: 1」——枚举名是给程序看的，
 * 学生看到的是现象。
 */
function driftChips(drift: Drift[]) {
  const out: { key: string; text: string; tone: 'warning' | 'success' | 'neutral' }[] = [];
  const count = (k: Drift['kind']) => drift.filter((d) => d.kind === k).length;
  const push = (k: Drift['kind'], text: string, tone: 'warning' | 'success' | 'neutral' = 'warning') => {
    if (count(k)) out.push({ key: k, text, tone });
  };
  push('overdue', `${count('overdue')} 项落后`);
  push('overrun', `${count('overrun')} 项耗时超预估`);
  push('underrun', `${count('underrun')} 项比预期快`, 'success');
  push('stalled', `${count('stalled')} 项停滞`);
  push('chainBlocked', `${count('chainBlocked')} 项被前置挡住`);
  push('milestoneRisk', `${count('milestoneRisk')} 个里程碑有风险`);
  push('budgetOver', `${count('budgetOver')} 周超载`);
  return out;
}

/** 负载自评 0.5 = 刚好。分档要说人话，不要显示 0.62 */
function loadLabel(v: number | null): string {
  if (v === null) return '未评';
  if (v <= 0.45) return '偏轻松';
  if (v <= 0.6) return '刚好';
  return '偏吃力';
}

export default function ReviewScreen() {
  const t = useTokens();
  const { plan, today, apply } = usePlanStore();

  /** 被学生拒绝的调整。默认全部接受——多数情况下列表是可直接采纳的 */
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const data = useMemo(() => {
    if (!plan) return null;
    const report = reviewPlan(plan, today);
    const local = engineView(plan, report);
    /**
     * 提醒 = 引擎的语义提醒（本地路径下为空）+ **格式层自己的警告**。
     *
     * 后者不能省：`validatePlan` 能发现一些引擎不管、但确实自相矛盾的事，
     * 比如「有任务被排到了目标截止日之后」。这类问题如果只躺在 warnings
     * 数组里没人看，等于没检查。
     *
     * ## 为什么这里带上 `path` 而不是只留文案
     *
     * 下面渲染时要用它做 key。曾经这里只映射出 `message`、然后 `key={c}`——
     * 于是只要有两条警告文案相同就炸：
     * `Encountered two children with the same key`（真机上真的报了这个）。
     *
     * 当时触发它的是三条「赛事缺少截止日期」（同一条规则对三个赛事各报一次，
     * 文案自然一模一样）。那条规则已经删了，但**键不能建立在"文案不会重复"
     * 这种假设上**——文案是给人看的，随时可能为了更好懂而改成一样的。
     * `path` 是结构性的（`resource:xxx` / `task:xxx`），它才该是键。
     */
    const formatWarnings = validatePlan(plan)
      .filter((i) => i.level === 'warn')
      .map((i) => ({ key: `fmt:${i.path}`, text: i.message }));
    return { report, local, last: plan.reviews.at(-1) ?? null, formatWarnings };
  }, [plan, today]);

  /**
   * 服务端 + 模型的复盘。
   *
   * 界面**先显示本机算出来的结果**，模型返回后再换上去——
   * 而不是先转圈等待。理由是断网/超时时这一屏本来就有正确答案，
   * 让学生盯着空白等一个"更好的措辞"是本末倒置。
   */
  const [remote, setRemote] = useState<{ view: AdvisorView; note: string } | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!plan) return;
    let alive = true;
    setAsking(true);
    void (async () => {
      const res = await fetchReview(serializePlan(plan), today);
      if (!alive) return;
      setAsking(false);
      setRemote(res.ok ? { view: res.value, note: res.note } : null);
    })();
    return () => {
      alive = false;
    };
  }, [plan, today]);

  if (!plan || !data) {
    return (
      <Screen>
        <ScreenHeader title="本周复盘" />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState glyph="!" title="计划文件读取失败" body="无法读取计划，请检查存储权限。" />
        </View>
      </Screen>
    );
  }

  const { report, local, last, formatWarnings } = data;
  const view = remote?.view ?? local;
  /**
   * 引擎的语义提醒（本地路径为空）+ 格式层自己的警告。
   *
   * 两个来源各自加命名空间再拼起来：它们互不知道对方的内容，
   * 用同样的字符串做 key 迟早会撞（见上面 `formatWarnings` 的注释）。
   * 引擎那边只有字符串数组，本身没有稳定 id，所以按序号编——
   * 它是一整批一起重算出来的，序号在同一批里就是稳定的。
   */
  const cautions = [
    ...view.cautions.map((text, i) => ({ key: `engine:${i}`, text })),
    ...formatWarnings,
  ];
  const chips = driftChips(report.drift);
  const total = view.adjustments.length;
  const accepted = view.adjustments.filter((a) => !rejected.has(a.taskId));
  const acceptCount = accepted.length;

  const toggle = (id: string) =>
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onApply = () => {
    apply({
      type: 'plan.applyAdjustments',
      applied: accepted.map((a) => ({
        kind: 'reschedule' as const,
        taskId: a.taskId,
        scheduledFor: a.to,
        // 存 LLM 改写后的理由（有就用），否则存引擎原文——复盘回放时读得懂
        reason: a.llmReason ?? a.engineReason,
      })),
    });
    setRejected(new Set());
  };

  return (
    <Screen>
      <ScreenHeader
        title="本周复盘"
        meta={`${today} · 计划 v${plan.version}`}
        right={
          total > 0 ? (
            <HeaderAction
              label="全部拒绝"
              accessibilityLabel="拒绝全部调整"
              onPress={() => setRejected(new Set(view.adjustments.map((a) => a.taskId)))}
            />
          ) : null
        }
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── 综述：本屏的视觉焦点 ─────────────────────────── */}
        <Card tone="accent" bordered>
          <AppText variant="caption" tone="textMuted" style={styles.eyebrow}>
            {view.narrativeSource === 'llm' ? 'AI 综述' : asking ? '系统综述 · AI 正在润色…' : '系统综述'}
          </AppText>
          <AppText variant="body">{view.narrative}</AppText>
        </Card>

        {/* ── 本期完成情况 ─────────────────────────────────── */}
        {last ? (
          <StatRow
            items={[
              {
                value: last.plannedTasks ? `${Math.round((last.completedTasks / last.plannedTasks) * 100)}%` : '—',
                label: '完成率',
                tone: 'primary',
              },
              { value: `${last.completedTasks}/${last.plannedTasks}`, label: '完成 / 计划' },
              {
                value: loadLabel(last.loadFeedback),
                label: '负载自评',
                tone: last.loadFeedback !== null && last.loadFeedback > 0.6 ? 'warning' : 'text',
              },
            ]}
          />
        ) : null}

        {/* ── 偏差 ────────────────────────────────────────── */}
        {chips.length > 0 ? (
          <View style={styles.chipRow}>
            {chips.map((c) => (
              <Chip key={c.key} tone={c.tone}>
                {c.text}
              </Chip>
            ))}
          </View>
        ) : null}

        {/* ── 调整列表 ─────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionLabel>待确认的调整 · {total} 项</SectionLabel>

          {total === 0 ? (
            <EmptyState
              glyph="✓"
              tone="success"
              title="本周无需调整"
              body="排期与你的可用时间匹配，按现在的节奏继续就行。"
            />
          ) : (
            <View style={styles.list}>
              {view.adjustments.map((a) => {
                const ok = !rejected.has(a.taskId);
                return (
                  <Card key={a.taskId} tone={ok ? 'surface' : 'sunken'} bordered>
                    <AppText variant="subtitle" tone={ok ? 'text' : 'textFaint'}>
                      {a.title}
                    </AppText>

                    <AppText variant="label" tone={ok ? 'primary' : 'textFaint'}>
                      {moveLabel(a)}
                    </AppText>

                    <AppText variant="label" tone="textMuted">
                      {a.llmReason ?? a.engineReason}
                    </AppText>

                    {/* 引擎原文与 AI 改写并列显示：让「AI 只是把话说得更好懂，
                        决定仍然是引擎做的」这件事在界面上可见（§7.0.2） */}
                    {a.llmReason ? (
                      <AppText variant="caption" tone="textFaint">
                        理由由 AI 改写 · 引擎原文：「{a.engineReason}」
                      </AppText>
                    ) : null}

                    <CheckControl
                      checked={ok}
                      label={ok ? '接受' : '已拒绝'}
                      accessibilityLabel={ok ? `拒绝对「${a.title}」的调整` : `接受对「${a.title}」的调整`}
                      onToggle={() => toggle(a.taskId)}
                    />
                  </Card>
                );
              })}
            </View>
          )}
        </View>

        {/* ── 提醒 ────────────────────────────────────────── */}
        {cautions.length > 0 ? (
          <View style={styles.section}>
            <SectionLabel>提醒 · {cautions.length} 条</SectionLabel>
            <Card bordered>
              {cautions.map((c, i) => (
                <View key={c.key} style={[styles.cautionRow, i > 0 ? { marginTop: space.md } : null]}>
                  <View style={[styles.dot, { backgroundColor: t.warning }]} />
                  <AppText variant="label" tone="textMuted" style={styles.cautionText}>
                    {c.text}
                  </AppText>
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </ScrollView>

      {/* 一屏唯一的 primary action。`bottomInset={0}`：
          tab 导航已经消费了底部安全区，这里再加会双份留白 */}
      <BottomBar bottomInset={0}>
        <View style={styles.countBox}>
          <AppText variant="caption" tone="textFaint">
            已选
          </AppText>
          <AppText variant="subtitle" tone={acceptCount ? 'text' : 'textFaint'}>
            {acceptCount} / {total} 项
          </AppText>
        </View>
        <PrimaryButton
          label={total === 0 ? '已是最新' : `应用调整`}
          disabled={acceptCount === 0}
          onPress={onApply}
        />
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
    gap: space.sm,
  },
  cautionRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  cautionText: {
    flex: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
  },
  countBox: {
    flex: 1,
  },
});
