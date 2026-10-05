/**
 * Onboarding 访谈流 —— 第一印象，也决定后面所有排期的输入质量。
 *
 * 一屏一题（§9.2 ①）：顶部细进度条、题面、题面下方的 `why`、底部明确的一个主要操作。
 *
 * 进度条刻意表达的是**信息完成度**而不是「第几题 / 共几题」：
 * 出题是模型决定的，总题数事先不知道；而"关键信息还缺几项"是确定的，
 * 学生也更关心「还要答多久」。所以条走到满 = 可以生成计划了。
 *
 * 出题走 `fetchNextQuestion`：服务端可用时由模型动态出题，
 * 不可用 / 超时 / 返回的题不合格时静默回退到本机题库，并把走了哪条路**显示出来**——
 * 「AI 出题」和「本机题库」是两种不同的诚实说法。
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  applyAnswer,
  describeProfile,
  emptyProfile,
  MAX_QUESTIONS,
  missingProfileFields,
  type Answer,
  type QuestionSpec,
} from '@sp/shared';

import { AppText } from '@/components/app-text';
import { BottomBar, PrimaryButton } from '@/components/bottom-bar';
import { Card, SectionLabel } from '@/components/card';
import { Chip } from '@/components/chip';
import { ProgressBar } from '@/components/progress-bar';
import {
  draftToAnswer,
  emptyDraft,
  initDraft,
  isAnswerEmpty,
  QuestionControl,
  type Draft,
} from '@/components/question-control';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { ScrollBody } from '@/components/scroll-body';
import { SourceBadge } from '@/components/source-badge';
import { StatRow } from '@/components/stat-row';
import { draftPlan, fetchNextQuestion, type Source } from '@/lib/api';
import { screenPadding, space, touchTarget, useTokens } from '@/theme';
import { nextStamp } from '@/state/clock';
import { usePlanStore } from '@/state/plan-store';
import { PLAN_ID } from '@/state/plan-store';

/** 关键信息一共几项。进度条的分母 */
const KEY_FIELDS = 5;

type Session = {
  /** 已生成的题目，顺序即访谈顺序 */
  queue: QuestionSpec[];
  cursor: number;
  answers: Record<string, Answer>;
  /** 未提交的编辑。按题目 id 存，「上一题」回去还能看到原来写了一半的内容 */
  drafts: Record<string, Draft>;
  done: boolean;
  /** 正在取下一题 */
  loading: boolean;
  /** 题目来自模型还是本机题库 */
  source: Source | null;
  note: string;
};

const initialSession = (): Session => ({
  queue: [],
  cursor: 0,
  answers: {},
  drafts: {},
  done: false,
  loading: true,
  source: null,
  note: '',
});

export default function OnboardingScreen() {
  const t = useTokens();
  const router = useRouter();
  const { today, planRev, installPlan } = usePlanStore();
  const [session, setSession] = useState<Session>(initialSession);
  const [gen, setGen] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  /** 首题。之后每一题都在 commit 里取 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetchNextQuestion(emptyProfile(), []);
      if (!alive) return;
      if (!res.ok) {
        setSession((s) => ({ ...s, loading: false, done: true }));
        return;
      }
      const { question, done, source, note } = res.value;
      setSession({
        queue: question ? [question] : [],
        cursor: 0,
        answers: {},
        drafts: {},
        done: done || !question,
        loading: false,
        source,
        note,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const profile = useMemo(
    () =>
      session.queue.reduce((p, q) => {
        const a = session.answers[q.id];
        return a ? applyAnswer(p, q, a) : p;
      }, emptyProfile()),
    [session.queue, session.answers],
  );

  const missing = missingProfileFields(profile);
  const progress = session.done ? 1 : (KEY_FIELDS - missing.length) / KEY_FIELDS;

  /** 记录当前题目的作答并前进。已经是最后一题时才向服务端要新题 */
  const commit = async (d: Draft) => {
    const cur = session.queue[session.cursor];
    if (!cur || session.loading) return;

    const answers = { ...session.answers, [cur.id]: draftToAnswer(cur, d) };
    const queue = session.queue;
    setSession((s) => ({ ...s, answers, loading: true }));

    // 「上一题」回去改答案后往前走：复用已有的下一题，不必再问一次模型
    if (session.cursor < queue.length - 1) {
      setSession((s) => ({ ...s, answers, loading: false, cursor: s.cursor + 1 }));
      return;
    }

    const nextProfile = queue.reduce((p, q) => {
      const a = answers[q.id];
      return a ? applyAnswer(p, q, a) : p;
    }, emptyProfile());

    const res = await fetchNextQuestion(nextProfile, queue);
    if (!res.ok) {
      setSession((s) => ({ ...s, answers, loading: false, done: true }));
      return;
    }
    const { done, question, source, note } = res.value;
    setSession((s) => ({
      ...s,
      answers,
      loading: false,
      source,
      note,
      done: done || !question,
      queue: question ? [...queue, question] : queue,
      cursor: question ? queue.length : s.cursor,
    }));
  };

  const onGenerate = async () => {
    setGen({ busy: true, error: null });
    /**
     * 生成要 20–40 秒，这里先记下**发起那一刻**的修订号。
     *
     * 学生在这期间如果回到今日页打了勾、改了时长，`installPlan` 会拿这个
     * 修订号比对，不一致就拒绝装入并说明原因——否则那些修改会被静默覆盖。
     */
    const revAtStart = planRev;
    const res = await draftPlan(profile, {
      id: PLAN_ID,
      now: nextStamp(),
      today,
      title: profile.goalStatement?.slice(0, 40) || '学习计划',
    });
    if (!res.ok) {
      setGen({ busy: false, error: res.error });
      return;
    }
    // 档案随计划一起装进去（`installPlan` 的第四个参数）——**一次写盘**。
    // 分两步会得到两个版本，而且中间失败会留下「有计划、没档案」，
    // 那正好就是「它不记得我说过的话」。
    installPlan(
      res.value.planText,
      `计划已生成（${res.value.source === 'llm' ? 'AI' : '本机'}）· ${res.value.summary}`,
      revAtStart,
      profile,
    );
    setGen({ busy: false, error: null });
    router.replace('/');
  };

  /* ── 结束页 ────────────────────────────────────────────── */
  if (session.done) {
    return (
      <DoneView
        summary={describeProfile(profile)}
        missing={missing}
        answered={session.queue.filter((q) => session.answers[q.id]).length}
        total={session.queue.length}
        busy={gen.busy}
        error={gen.error}
        onGenerate={() => void onGenerate()}
      />
    );
  }

  /* ── 首题还在路上 ──────────────────────────────────────── */
  if (!session.queue.length) {
    return (
      <Screen>
        <ScreenHeader title="先聊聊你的情况" />
        <View style={styles.loading}>
          <ActivityIndicator color={t.primary} />
          <AppText variant="label" tone="textMuted">
            正在准备第一个问题…
          </AppText>
        </View>
      </Screen>
    );
  }

  const q = session.queue[session.cursor];
  const draft = session.drafts[q.id] ?? initDraft(q, session.answers[q.id]);
  const answer = draftToAnswer(q, draft);
  const empty = isAnswerEmpty(q, answer);

  return (
    <Screen>
      <ScreenHeader
        title="先聊聊你的情况"
        meta={`第 ${session.cursor + 1} 题 · 信息 ${KEY_FIELDS - missing.length}/${KEY_FIELDS} · 最多 ${MAX_QUESTIONS} 题`}
        right={
          session.cursor > 0 ? (
            <HeaderAction
              label="上一题"
              accessibilityLabel="回到上一题"
              onPress={() => setSession((s) => ({ ...s, cursor: s.cursor - 1 }))}
            />
          ) : null
        }
      />

      <View style={styles.progress}>
        <ProgressBar value={progress} height={4} />
      </View>

      <ScrollBody
        contentContainerStyle={[styles.scroll, styles.questionScroll]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Card style={styles.card}>
          <AppText variant="title">{q.prompt}</AppText>
          {/* why 必须存在（契约里就是必填）——它表明每一题都对应一个排期决策 */}
          <AppText variant="label" tone="textMuted">
            {q.why}
          </AppText>

          <View style={[styles.controls, { borderTopColor: t.border }]}>
            <QuestionControl
              question={q}
              draft={draft}
              onChange={(next) => setSession((s) => ({ ...s, drafts: { ...s.drafts, [q.id]: next } }))}
              today={today}
            />
          </View>
        </Card>

        {/* 出题来源。收起成一个小标，点开才解释——它属于「想知道才看」的信息，
            不该摆在学生正在答题的位置上打断他 */}
        {session.source ? (
          <SourceBadge
            source={session.source}
            note={session.note}
            llmLabel="题目由 AI 根据你前面的回答动态生成。"
            detail={
              session.source === 'local'
                ? `题目来自本机题库${session.note && session.note !== 'ok' ? `（${session.note}）` : ''}。断网时不影响继续答。`
                : undefined
            }
          />
        ) : null}

        {/* 已经了解到的信息，边答边长。让学生看见"系统确实记住了" */}
        {profile.goalStatement || describeProfile(profile) ? (
          <View style={styles.section}>
            <SectionLabel>已经了解</SectionLabel>
            <View style={styles.wrap}>
              {profile.goalStatement ? (
                <Chip tone="accent">
                  {profile.goalStatement.slice(0, 20)}
                  {profile.goalStatement.length > 20 ? '…' : ''}
                </Chip>
              ) : null}
              {describeProfile(profile)
                .split(' · ')
                .filter(Boolean)
                .map((s) => (
                  <Chip key={s} tone="neutral">
                    {s}
                  </Chip>
                ))}
            </View>
          </View>
        ) : null}
      </ScrollBody>

      <BottomBar>
        <AppText
          variant="label"
          tone="textFaint"
          accessibilityRole="button"
          accessibilityLabel="跳过这一题"
          onPress={() => void commit(emptyDraft())}
          suppressHighlighting
          style={styles.skip}
        >
          跳过
        </AppText>
        <View style={styles.spacer} />
        <PrimaryButton
          label={session.loading ? '正在取下一题…' : empty ? '先跳过这题' : '继续'}
          disabled={session.loading}
          onPress={() => void commit(draft)}
        />
      </BottomBar>
    </Screen>
  );
}

/* ------------------------------------------------------------------ *
 * 结束页
 * ------------------------------------------------------------------ */

function DoneView({
  summary,
  missing,
  answered,
  total,
  busy,
  error,
  onGenerate,
}: {
  summary: string;
  missing: string[];
  answered: number;
  total: number;
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  return (
    <Screen>
      <ScreenHeader title="信息够了" meta={`答了 ${answered} / ${total} 题`} />

      <ScrollBody contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <StatRow
          items={[
            { value: `${answered}`, label: '已作答', tone: 'primary' },
            { value: `${5 - missing.length}/5`, label: '关键信息' },
            {
              value: missing.length === 0 ? '可以了' : `${missing.length} 项`,
              label: missing.length === 0 ? '资料完整度' : '还缺',
              tone: missing.length === 0 ? 'success' : 'warning',
            },
          ]}
        />

        <Card bordered>
          <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
            我记住的情况
          </AppText>
          <AppText variant="body">{summary || '（几乎都跳过了，只能给一份通用的入门安排）'}</AppText>
        </Card>

        {missing.length > 0 ? (
          <Card tone="accent" bordered>
            <AppText variant="caption" tone="textMuted" style={styles.eyebrow}>
              还缺这些
            </AppText>
            <AppText variant="body">{missing.join('、')}</AppText>
            <AppText variant="label" tone="textMuted">
              不影响继续——但缺截止日就只能按每周固定量推进，没法倒排；
              缺可用时间就只能给一份排不进你日程的计划。
            </AppText>
          </Card>
        ) : null}

        {error ? (
          <Card bordered>
            <AppText variant="caption" tone="danger" style={styles.eyebrow}>
              没能生成
            </AppText>
            <AppText variant="label" tone="textMuted">
              {error}
            </AppText>
          </Card>
        ) : null}
      </ScrollBody>

      <BottomBar>
        <View style={styles.spacer} />
        <PrimaryButton label={busy ? '正在生成…' : '生成计划'} disabled={busy} onPress={onGenerate} />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  progress: {
    paddingHorizontal: screenPadding,
    paddingBottom: space.lg,
  },
  scroll: {
    paddingHorizontal: screenPadding,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.xl,
  },
  /**
   * 一屏一题时内容常常只占上半屏，剩余空白会让页面看起来"没做完"。
   * `flexGrow + center` 让短内容垂直居中，长内容（比如七个选项的多选题）
   * 仍然从顶部正常滚动——两种情况下都不需要各写一套布局。
   */
  questionScroll: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  card: {
    gap: space.md,
  },
  controls: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.lg,
    marginTop: space.xs,
  },
  section: {
    gap: space.md,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  spacer: {
    flex: 1,
  },
  skip: {
    minHeight: touchTarget,
    paddingVertical: space.md,
    textAlignVertical: 'center',
  },
  eyebrow: {
    letterSpacing: 0.6,
  },
});
