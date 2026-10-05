/**
 * 复盘 —— 一屏六块，学生停下来把这一周过一遍。
 *
 * ## 它不是标签页，是一场会话
 *
 * 它挂在 `/review`（**推入的整屏**），不在底部标签栏里。理由是这一条：
 * 标签栏表达的是「一个你随时可以回来的地方」，而复盘是「一件有开始有结束的事」。
 * 会话走完就回今日页，那个位置不该一直杵在那儿催人。
 *
 * 入口在今日页顶部（`<ReviewEntry />`），完全由学生手动触发。
 * 入口组件与位置是**解耦的**：换地方是一处改动；将来「程序主动提示复盘」
 * 也只是另一个组件调同一个 `useReviewLauncher()`。
 *
 * ## 六块的顺序为什么不能换
 *
 *   ① 这周发生了什么（引擎算的事实）
 *   ② 先问一句（0–2 题，只有学生知道答案的那种）
 *   ③ 我建议这样调（**计划修改的大体方向**）
 *   ④ 帮你写好的卡片（2–3 张示例，可编辑、可划掉）
 *   ⑤ 现在的安排（周条 + 那天的任务卡 +〔日历〕）
 *   ⑥ 之前的复盘（折叠，过去几次说了什么、改了什么）
 *
 * ② 的答案决定 ③ 往哪边写；⑤ 放在卡片后面，是因为学生对着建议时
 * 最想确认的是「现在到底排成什么样」，放前面就得来回翻。
 *
 * ## 为什么整场会话是本地算的
 *
 * 事实、问题、候选卡、方向全部由本机规则产出（见 `review-session.ts`），
 * 所以**断网时这一屏完整可用**。模型只做一件事：把方向那句话说得更顺。
 * 它拿到之后换上去，拿不到就用本机那句——两种都在，界面上标明来源。
 *
 * ## 为什么会话状态在 store 里
 *
 * 因为〔编辑〕要跨屏（进编辑页改完再回来）。放在这一屏的 `useState` 里，
 * 那次跳转就把它丢了。
 */
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { proposalKey, reviewFacts, reviewPlan, serializePlan } from '@sp/shared';
import type { Answer, QuestionSpec } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { BottomBar, PrimaryButton } from '@/components/bottom-bar';
import { Card, ChipAction, SectionHeader } from '@/components/card';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { NoticeBanner } from '@/components/notice-banner';
import { PlanWarnings } from '@/components/plan-warnings';
import { ProposalCard } from '@/components/proposal-card';
import { SourceBadge } from '@/components/source-badge';
import { QuestionControl, draftToAnswer, initDraft, isAnswerEmpty, type Draft } from '@/components/question-control';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { TaskList } from '@/components/task-list';
import { WeekStrip, type WeekStripDay } from '@/components/week-strip';
import { fetchReview } from '@/lib/api';
import { fmtFull, fmtMinutes, startOfWeek, weekDays } from '@/lib/dates';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export default function ReviewScreen() {
  const router = useRouter();
  const {
    plan,
    today,
    storageReady,
    notice,
    dismissNotice,
    session,
    startReview,
    answerReview,
    editProposal,
    toggleProposal,
    applySession,
    discardSession,
  } = usePlanStore();

  /** ⑤ 里选中哪天。默认今天 */
  const [selectedDay, setSelectedDay] = useState(today);
  /** ⑥ 折叠着，不占地方 */
  const [logOpen, setLogOpen] = useState(false);

  /**
   * 进来就开一次会话——但要**等时钟接上**，而且**除非已经有一次在进行中**。
   *
   * 两个条件都是踩出来的：
   *
   * · **等时钟接上**：启动顺序是「设置 → 时钟 → 计划」，而 `storageReady`
   *   是这三步都走完之后才置上的。不等的话，首帧用的 `today` 是**设备日期**，
   *   引擎会按那个日期算出一份排期——而卡片上就出现了相对真实今天已经过去的日期
   *   （实测：真实今天 10/19，卡片写着「→ 10/14」）。这类 bug 只在时区/调试日期
   *   和真实日期不一致时露头，而那恰好是我们的常态。
   * · **除非已经在进行中**：学生翻到 ④ 时退出去看一眼今日页再回来，
   *   重新开一次会把他刚改过的卡片全部冲掉。
   */
  useEffect(() => {
    if (!storageReady) return;
    if (!session || session.source !== 'review') startReview();
  }, [storageReady, session, startReview]);

  useEffect(() => {
    setSelectedDay(today);
  }, [today]);

  /** ③ 里的方向：先显示本机那句，模型返回后换上去 */
  const [narrative, setNarrative] = useState<{ text: string; source: 'llm' | 'local'; note: string } | null>(null);
  useEffect(() => {
    if (!plan) return;
    let alive = true;
    void (async () => {
      const res = await fetchReview(serializePlan(plan), today);
      if (!alive) return;
      // 只用它的叙述。**建议改成什么由本机规则决定**（引擎算、模型说），
      // 所以这里刻意不看它返回的 adjustments
      if (res.ok && res.value.narrativeSource === 'llm') {
        setNarrative({ text: res.value.narrative, source: 'llm', note: res.note });
      } else {
        setNarrative({ text: '', source: 'local', note: res.ok ? res.note : res.error });
      }
    })();
    return () => {
      alive = false;
    };
  }, [plan, today]);

  const view = useMemo(() => {
    if (!plan) return null;
    const report = reviewPlan(plan, today);
    const days = weekDays(startOfWeek(today));
    const byDay = new Map<string, typeof plan.tasks>();
    for (const tk of plan.tasks) {
      if (!tk.scheduledFor) continue;
      const bucket = byDay.get(tk.scheduledFor);
      if (bucket) bucket.push(tk);
      else byDay.set(tk.scheduledFor, [tk]);
    }
    const on = (d: string) => byDay.get(d) ?? [];
    return {
      facts: reviewFacts(plan, report),
      strip: days.map<WeekStripDay>((d) => ({
        day: d,
        minutes: on(d).reduce((s, x) => s + x.estimateMin, 0),
        done: on(d).filter((x) => x.status === 'done').length,
        total: on(d).length,
        isToday: d === today,
      })),
      minutesOn: (d: string) => on(d).reduce((s, x) => s + x.estimateMin, 0),
      dayTasks: on(selectedDay),
      /** ⑥ 只列复盘，不列结账——它们是两种记录（`Review.kind`） */
      log: plan.reviews.filter((r) => r.kind === 'review').slice(-3).reverse(),
    };
  }, [plan, today, selectedDay]);

  /**
   * 离开复盘。
   *
   * 现在 `/review` 一定是**推入**的整屏，所以正解是 `back()`——它干净地把栈弹掉。
   * 原来写的是 `router.replace('/')`（那时候复盘还是个标签页），而推入之后再 replace
   * 会**在栈里再放一份 tabs**：端到端里就表现为「页面上有两个今日页，第一个是隐藏的」，
   * 于是按 DOM 顺序取到的第一个勾选框点不着。这类残留平时看不出来，
   * 但它会随着每一次复盘一点点堆起来。
   */
  const leaveReview = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!plan || !view) {
    return (
      <Screen>
        <ScreenHeader title="复盘" />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState glyph="!" title="计划文件读取失败" body="无法读取计划，请检查存储权限。" />
        </View>
      </Screen>
    );
  }

  const direction = narrative?.text || session?.direction || '';
  const kept = session ? session.proposals.filter((p) => !session.dropped.includes(proposalKey(p))) : [];
  const editedKeys = new Set(
    (session?.proposals ?? [])
      .filter((p) => JSON.stringify(p) !== JSON.stringify(session?.origin.find((o) => proposalKey(o) === proposalKey(p))))
      .map(proposalKey)
  );

  return (
    <Screen>
      <ScreenHeader
        title="复盘"
        meta={`${fmtFull(today)} · 计划 v${plan.version}`}
        right={
          <HeaderAction
            label="先不聊了"
            accessibilityLabel="放弃这次复盘"
            onPress={() => {
              discardSession();
              setNarrative(null);
              leaveReview();
            }}
          />
        }
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <NoticeBanner notice={notice} onDismiss={dismissNotice} />

        {/* ── ① 这周发生了什么 ───────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader>这周发生了什么</SectionHeader>
          <Card bordered style={styles.stack}>
            <AppText variant="body">{view.facts.text}</AppText>
            {view.facts.chips.length ? (
              <View style={styles.chipRow}>
                {view.facts.chips.map((c) => (
                  <Chip key={c.key} tone={c.tone}>
                    {c.text}
                  </Chip>
                ))}
              </View>
            ) : null}
          </Card>
        </View>

        {/* ── ② 先问一句（没有问题就整块不出现） ─────────── */}
        {session?.questions.length ? (
          <View style={styles.section}>
            <SectionHeader>先问一句</SectionHeader>
            {session.questions.map((q) => (
              <QuestionBlock
                key={q.id}
                question={q}
                today={today}
                answered={session.answers[q.id]}
                onChange={(draft) => {
                  const answer = draftToAnswer(q, draft);
                  if (!isAnswerEmpty(q, answer)) answerReview(q.id, answer);
                }}
              />
            ))}
          </View>
        ) : null}

        {/* ── ③ 我建议这样调 ─────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader>我建议这样调</SectionHeader>
          <Card bordered style={styles.stack}>
            <AppText variant="body">{direction || '（正在整理…）'}</AppText>
            {/*
              来源徽标放在**卡片里**，不放在标题行右边。
              标题行的右边是「动作位」（宽度有限），而这个徽标点开之后要展开一句话——
              放进去会把标题挤成一列竖排的字（第一次就是这么渲染出来的）。
              徽标属于它描述的那段内容，放在一起才对。
            */}
            <SourceBadge
              source={narrative?.source ?? null}
              note={narrative?.note}
              detail={
                narrative?.source === 'llm'
                  ? '这段话由 AI 把引擎算出来的结论说得更顺。改成什么由引擎决定，它只负责措辞。'
                  : narrative?.note
                    ? `没连上 AI，这句话是本机按事实拼的（${narrative.note}）`
                    : '这句话是本机按事实拼的。'
              }
            />
          </Card>
        </View>

        {/* ── ④ 帮你写好的卡片 ───────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader
            right={
              kept.length !== (session?.proposals.length ?? 0) ? (
                <ChipAction
                  label="全部要"
                  accessibilityLabel="把划掉的都恢复"
                  onPress={() => {
                    for (const p of session?.dropped ?? []) toggleProposal(p);
                  }}
                />
              ) : null
            }
          >
            帮你写好的卡片 · {session?.proposals.length ?? 0} 张
          </SectionHeader>

          {session?.proposals.length ? (
            <View style={styles.list}>
              {session.proposals.map((p) => {
                const key = proposalKey(p);
                return (
                  <ProposalCard
                    key={key}
                    proposal={p}
                    plan={plan}
                    kept={!session.dropped.includes(key)}
                    edited={editedKeys.has(key)}
                    onToggle={() => toggleProposal(key)}
                    /**
                     * 带 `?proposal=<key>` 进编辑页 = **改这张建议卡**，
                     * 预填的是「建议之后的值」，保存写回会话、不碰计划。
                     * 见 `app/task/[id].tsx` 里的建议卡模式。
                     */
                    onEdit={() =>
                      router.push({
                        pathname: '/task/[id]',
                        params: {
                          id: ('taskId' in p ? p.taskId : 'new'),
                          proposal: key,
                        },
                      })
                    }
                  />
                );
              })}
            </View>
          ) : (
            <EmptyState
              glyph="✓"
              tone="success"
              title="这周没有必须改的东西"
              body="排期和你实际做的情况对得上，按现在的节奏继续就行。"
            />
          )}

          {session?.refusals.length ? (
            <Card bordered style={styles.stack}>
              <AppText variant="label" tone="textMuted">
                这些我做不到：{session.refusals.join('、')}
              </AppText>
            </Card>
          ) : null}
        </View>

        {/* ── ⑤ 现在的安排 ───────────────────────────────── */}
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
            现在的安排 · 点日期切换
          </SectionHeader>
          <WeekStrip days={view.strip} selected={selectedDay} onSelect={setSelectedDay} />

          <AppText variant="label" tone="textFaint">
            {selectedDay === today ? '今天' : fmtFull(selectedDay)} · {view.dayTasks.length} 项
            {view.minutesOn(selectedDay) > 0 ? ` · ${fmtMinutes(view.minutesOn(selectedDay))}` : ''}
          </AppText>

          <TaskList
            tasks={view.dayTasks}
            plan={plan}
            expandedId={null}
            onToggleExpand={() => undefined}
            onOpenEditor={(taskId) => router.push({ pathname: '/task/[id]', params: { id: taskId } })}
            empty={{
              glyph: '○',
              title: '这天没有安排',
              body: '点上面别的日子看看。',
            }}
          />
        </View>

        {/* ── ⑥ 之前的复盘（折叠） ───────────────────────── */}
        {view.log.length ? (
          <View style={styles.section}>
            <SectionHeader
              right={
                <ChipAction
                  label={logOpen ? '收起' : '展开'}
                  accessibilityLabel={logOpen ? '收起之前的复盘' : '展开之前的复盘'}
                  onPress={() => setLogOpen((x) => !x)}
                />
              }
            >
              之前的复盘 · {view.log.length} 次
            </SectionHeader>

            {logOpen ? (
              <View style={styles.list}>
                {view.log.map((r) => (
                  <Card key={r.at} tone="sunken" bordered style={styles.stack}>
                    <AppText variant="label" tone="textMuted">
                      {fmtFull(r.at.slice(0, 10))}
                    </AppText>
                    {r.notes ? (
                      <AppText variant="label" tone="text">
                        {r.notes}
                      </AppText>
                    ) : null}
                    {r.dialogue.length ? (
                      <View style={styles.stack}>
                        {r.dialogue.map((d, i) => (
                          <AppText key={`${r.at}-${i}`} variant="caption" tone="textFaint">
                            {d.prompt} → {d.answer}
                          </AppText>
                        ))}
                      </View>
                    ) : null}
                    {r.adjustments.length ? (
                      <AppText variant="caption" tone="textFaint">
                        改了 {r.adjustments.length} 处：{r.adjustments.join('；')}
                      </AppText>
                    ) : (
                      <AppText variant="caption" tone="textFaint">
                        这次没有改动
                      </AppText>
                    )}
                  </Card>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 规划相关的警告：和今日页、目标屏是**同一个组件**（措辞一处实现） */}
        <PlanWarnings plan={plan} />
      </ScrollView>

      {/* 这一屏不在标签栏里，所以底部安全区要自己留（在标签页里才传 0） */}
      <BottomBar>
        <View style={styles.countBox}>
          <AppText variant="caption" tone={kept.length ? 'textFaint' : 'warning'}>
            {kept.length ? '已选' : '一张都没选'}
          </AppText>
          <AppText variant="subtitle" tone={kept.length ? 'text' : 'textFaint'}>
            {kept.length} 张
          </AppText>
        </View>
        <PrimaryButton
          label={session?.proposals.length ? `应用 ${kept.length} 张` : '没什么要改的'}
          disabled={!kept.length}
          onPress={() => {
            applySession();
            setNarrative(null);
            leaveReview();
          }}
        />
      </BottomBar>
    </Screen>
  );
}

/**
 * 一个问题。**点一下就作答**，没有「下一题」按钮。
 *
 * 复盘的题目都是单选题（见 `reviewQuestions`），所以一次点击就是一次完整的回答；
 * 再加一个确认按钮只会让「两个问题」变成四次交互。
 */
function QuestionBlock({
  question,
  today,
  answered,
  onChange,
}: {
  question: QuestionSpec;
  today: string;
  answered?: Answer;
  onChange: (draft: Draft) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initDraft(question, answered));
  return (
    <Card bordered style={styles.stack}>
      <AppText variant="subtitle">{question.prompt}</AppText>
      <AppText variant="label" tone="textMuted">
        {question.why}
      </AppText>
      <View style={styles.controls}>
        <QuestionControl
          question={question}
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            onChange(next);
          }}
          today={today}
        />
      </View>
    </Card>
  );
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
  /** 徽标展开的那句话要能换行，所以这一行不能是「标题行右边那个窄位」 */
  badgeRow: {
    marginTop: space.xs,
  },
  stack: {
    gap: space.sm,
  },
  list: {
    gap: space.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  controls: {
    marginTop: space.xs,
  },
  countBox: {
    flex: 1,
  },
});
