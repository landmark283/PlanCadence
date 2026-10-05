/**
 * 跟 AI 说说 —— 学生用一句话改计划。
 *
 * ## 一种输入，四种去处
 *
 *   输入   → 打一句话（空态给三个真实可用的例子，它们同时是**能力说明书**）
 *   澄清   → AI 没把握时先问，**有澄清就绝不同时给提案**
 *   待确认 → 一张张卡片，可编辑可划掉，一条命令写回
 *   不可用 → 明确说「现在连不上」+ 手动入口（见文件末尾那段）
 *
 * ## 这张卡和复盘第四块是同一个组件
 *
 * (`ProposalCard`)：因为两者的产出是同一个类型、写入走同一条命令。
 * 这就是「自己改和让 AI 改是同一批能力」在代码上的样子——
 * 不会出现「AI 能改但我改不了」。
 *
 * ## 为什么这一条没有本机兜底
 *
 * 它本质是自然语言理解。做一个「只听得懂三句话」的关键词解析器，
 * 学生试两次失败之后就不信它了，而那比「明确说没连上」伤得多。
 * 所以不可用时显示的是**空态 + 手动入口**，不是一句「出错了」。
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { proposalKey } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { BottomBar, PrimaryButton } from '@/components/bottom-bar';
import { Card, ChipAction, SectionHeader } from '@/components/card';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { Input } from '@/components/input';
import { NoticeBanner } from '@/components/notice-banner';
import { ProposalCard } from '@/components/proposal-card';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { ScrollBody } from '@/components/scroll-body';
import { SourceBadge } from '@/components/source-badge';
import { fmtFull, fmtMonthDay } from '@/lib/dates';
import { screenPadding, space, useTokens } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

/** 空态给三个真实可用的例子。它们同时是「这个框能干什么」的说明书 */
const EXAMPLES = [
  '周三晚上有事，那两项挪到周末',
  '这周太难了，少排一点',
  '目标改成保省二就行',
];

export default function TalkScreen() {
  const t = useTokens();
  const router = useRouter();
  const {
    plan,
    today,
    notice,
    dismissNotice,
    session,
    sayToAi,
    answerTalk,
    editProposal,
    toggleProposal,
    applySession,
    discardSession,
  } = usePlanStore();

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const view = useMemo(() => {
    if (!plan) return null;
    const scheduled = plan.tasks.filter((x) => x.scheduledFor);
    const thisWeek = scheduled.filter((x) => x.scheduledFor! >= today && x.scheduledFor! <= addDaysStr(today, 6));
    return {
      total: plan.tasks.length,
      week: thisWeek.length,
      deadline: plan.goal.deadline,
    };
  }, [plan, today]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!plan || !view) {
    return (
      <Screen>
        <ScreenHeader title="跟 AI 说说" right={<HeaderAction label="返回" onPress={goBack} />} />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState glyph="!" title="计划还没读出来" body="稍后再试，或者先去文件页看看存储状态。" />
        </View>
      </Screen>
    );
  }

  const history = session?.source === 'talk' ? session.history : [];
  const unavailable = session?.source === 'talk' ? session.unavailable : null;
  const questions = session?.source === 'talk' ? session.questions : [];
  const proposals = session?.source === 'talk' ? session.proposals : [];
  const refusals = session?.source === 'talk' ? session.refusals : [];
  const kept = session ? proposals.filter((p) => !session.dropped.includes(proposalKey(p))) : [];
  /** 最后一句学生的话——「重试」用它 */
  const lastUtterance = [...history].reverse().find((h) => h.role === 'student');

  const send = async (utterance: string) => {
    const text = utterance.trim();
    if (!text || busy) return;
    setBusy(true);
    setText('');
    await sayToAi(text);
    setBusy(false);
  };

  return (
    <Screen>
      <ScreenHeader
        title="跟 AI 说说"
        meta={`${fmtFull(today)} · 计划 v${plan.version}`}
        right={
          <HeaderAction
            label="返回"
            accessibilityLabel="返回"
            onPress={() => {
              discardSession();
              goBack();
            }}
          />
        }
      />

      <ScrollBody
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <NoticeBanner notice={notice} onDismiss={dismissNotice} />

        {/* ── 现在的计划：给这句话一个上下文 ───────────────── */}
        {history.length === 0 ? (
          <>
            <Card bordered style={styles.stack}>
              <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
                你的计划现在是这样
              </AppText>
              <AppText variant="label" tone="textMuted">
                {view.total} 项任务 · 本周 {view.week} 项
                {view.deadline ? ` · 目标 ${fmtMonthDay(view.deadline)}` : ''}
              </AppText>
            </Card>

            <View style={styles.section}>
              <SectionHeader>试试这样说</SectionHeader>
              <View style={styles.chipRow}>
                {EXAMPLES.map((e) => (
                  <Chip key={e} tone="neutral" accessibilityLabel={`用这个例子：${e}`} onPress={() => void send(e)}>
                    {e}
                  </Chip>
                ))}
              </View>
            </View>
          </>
        ) : null}

        {/* ── 对话：学生的话与 AI 的复述 ───────────────────── */}
        {history.length ? (
          <View style={styles.section}>
            <SectionHeader>对话</SectionHeader>
            {/* 徽标放在内容一起（不进标题行的右边）：它点开会展开一句话 */}
            <SourceBadge
              source={session?.unavailable ? null : 'llm'}
              llmLabel="这一条由 AI 理解你说的话之后给出。"
            />
            {history.map((h, i) =>
              h.role === 'student' ? (
                <View key={`s${i}`} style={[styles.bubble, styles.mine, { backgroundColor: t.primarySoft }]}>
                  <AppText variant="body">{h.text}</AppText>
                </View>
              ) : (
                <View key={`a${i}`} style={[styles.bubble, { backgroundColor: t.surface, borderColor: t.border }]}>
                  <AppText variant="body">{h.understanding}</AppText>
                </View>
              )
            )}
          </View>
        ) : null}

        {/* ── 这一段用不了：说清楚，并给手动入口 ───────────── */}
        {unavailable ? (
          <View style={styles.section}>
            <SectionHeader>现在用不了</SectionHeader>
            <Card bordered style={styles.stack}>
              <AppText variant="body">
                它是靠理解你说的话来干活的，本机做不到这件事——不猜，也不假装。
              </AppText>
              <AppText variant="caption" tone="textFaint">
                {unavailable}
              </AppText>
              <View style={styles.chipRow}>
                <ChipAction
                  label="重试"
                  accessibilityLabel="再试一次"
                  onPress={() => {
                    if (lastUtterance?.role === 'student') void send(lastUtterance.text);
                  }}
                />
                <ChipAction
                  label="打开日历"
                  accessibilityLabel="打开日历，自己挪"
                  onPress={() => router.push('/calendar')}
                />
                <ChipAction
                  label="手动改某一项"
                  accessibilityLabel="回今日页手动改"
                  onPress={() => {
                    discardSession();
                    router.replace('/');
                  }}
                />
              </View>
              <AppText variant="caption" tone="textFaint">
                复盘不受影响：断网时它照样能走完（题目和建议都是本机算的）。
              </AppText>
            </Card>
          </View>
        ) : null}

        {/* ── 需要澄清：**只有问题，没有提案** ─────────────── */}
        {!unavailable && questions.length ? (
          <View style={styles.section}>
            <SectionHeader>先确认一下</SectionHeader>
            {questions.map((q) => (
              <Card key={q.id} bordered style={styles.stack}>
                <AppText variant="subtitle">{q.prompt}</AppText>
                <AppText variant="label" tone="textMuted">
                  {q.why}
                </AppText>
                <View style={styles.chipRow}>
                  {q.options.map((o) => (
                    <Chip
                      key={o.value}
                      tone="neutral"
                      accessibilityLabel={`回答：${o.label}`}
                      onPress={() => {
                        if (busy) return;
                        setBusy(true);
                        void answerTalk(q.id, o.label).then(() => setBusy(false));
                      }}
                    >
                      {o.label}
                    </Chip>
                  ))}
                </View>
                {/* 每一项的 suggestions 是引擎给的**具体候选**（比如那几项任务的名字），
                    它们不是选项，是「我问的是这几项」的说明 */}
                {q.suggestions.length ? (
                  <AppText variant="caption" tone="textFaint">
                    涉及：{q.suggestions.join('、')}
                  </AppText>
                ) : null}
              </Card>
            ))}
          </View>
        ) : null}

        {/* ── 待确认 ───────────────────────────────────────── */}
        {!unavailable && proposals.length ? (
          <View style={styles.section}>
            <SectionHeader
              right={
                kept.length !== proposals.length ? (
                  <ChipAction
                    label="全部要"
                    accessibilityLabel="把划掉的都恢复"
                    onPress={() => {
                      for (const k of session?.dropped ?? []) toggleProposal(k);
                    }}
                  />
                ) : null
              }
            >
              准备做的改动 · {proposals.length} 项
            </SectionHeader>
            {proposals.map((p) => {
              const key = proposalKey(p);
              return (
                <ProposalCard
                  key={key}
                  proposal={p}
                  plan={plan}
                  kept={!session!.dropped.includes(key)}
                  onToggle={() => toggleProposal(key)}
                  onEdit={() =>
                    router.push({
                      pathname: '/task/[id]',
                      params: { id: 'taskId' in p ? p.taskId : 'new', proposal: key },
                    })
                  }
                />
              );
            })}
          </View>
        ) : null}

        {/* ── 做不到的事，明说 ─────────────────────────────── */}
        {!unavailable && refusals.length ? (
          <View style={styles.section}>
            <SectionHeader>这些我做不到</SectionHeader>
            <Card bordered style={styles.stack}>
              {refusals.map((r, i) => (
                <AppText key={`r${i}`} variant="label" tone="textMuted">
                  · {r}
                </AppText>
              ))}
            </Card>
          </View>
        ) : null}
      </ScrollBody>

      <BottomBar>
        {kept.length ? (
          <>
            <View style={styles.countBox}>
              <AppText variant="caption" tone="textFaint">
                已选
              </AppText>
              <AppText variant="subtitle">
                {kept.length} 项
              </AppText>
            </View>
            <PrimaryButton
              label={`应用 ${kept.length} 项`}
              onPress={() => {
                applySession();
                router.replace('/');
              }}
            />
          </>
        ) : (
          <>
            <Input
              value={text}
              onChangeText={setText}
              onSubmitEditing={() => void send(text)}
              placeholder={busy ? '正在理解…' : '说点什么…'}
              editable={!busy}
              returnKeyType="send"
              accessibilityLabel="对计划说一句话"
              style={styles.input}
            />
            <PrimaryButton label={busy ? '…' : '发送'} disabled={busy || !text.trim()} onPress={() => void send(text)} />
          </>
        )}
      </BottomBar>
    </Screen>
  );
}

/** 只用来算「本周」的右端。shared 的 addDays 已经在别处用了，这里不重造 */
function addDaysStr(day: string, n: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: screenPadding,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    gap: space.xl,
  },
  section: {
    gap: space.md,
  },
  stack: {
    gap: space.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    alignItems: 'center',
  },
  /** 对话气泡：学生的话靠主色浅底，AI 的话靠描边——一眼分得出谁说的 */
  bubble: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  mine: {
    borderColor: 'transparent',
  },
  countBox: {
    flex: 1,
  },
  input: {
    flex: 1,
  },
  eyebrow: {
    letterSpacing: 0.6,
  },
});
