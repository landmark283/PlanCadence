/**
 * 任务编辑页 —— 卡片上改不了的东西都在这里。
 *
 * ## 一条硬规则：除了标题和备注，没有任何自由文本输入
 *
 * 日期用月历点、时长用档位加减、类型/标记/前置/资料全部点选。
 * 理由不是审美，是准确性：
 *   · 手打日期要求学生在脑子里做格式转换，而**旁边就有一张月历**；
 *   · 手打日期是「输错了要等报错才知道」，点格子不可能点出一个不存在的日期；
 *   · 键盘会顶起半屏，正好盖住下面要看的东西。
 *
 * ## 一次保存 = 一条命令
 *
 * 改动全攒在本地草稿里，点「保存」才发**一条** `task.edit`。
 * 理由见 `commands.ts` 里那段：拆成四条的话，中间任何一条被拒都会让前面几条
 * 已经生效，而**现在没有版本管理可以整体退回去**——学生看到的是
 * 「标题改了、日期没改」，得自己想起来改了哪几处。一条命令是要么全成要么全不成。
 *
 * ## 保存失败时不返回
 *
 * 命令层拒绝（空标题、非法时长、前置成环）会把理由写进 `notice`，
 * 而 `notice` 是显示在**当前这一屏**的。如果先 `router.back()` 再让它报错，
 * 提示就飘到上一屏去了，学生只会觉得「点了没反应」。
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ESTIMATE_STEP,
  MAX_ESTIMATE_MIN,
  MIN_ESTIMATE_MIN,
  blankDraft,
  draftOf,
  monthOf,
  newTaskId,
  inMonth,
  proposalKey,
  resolveTags,
  taskPatch,
  withScheduledFor,
} from '@sp/shared';
import type { TaskDraft, TaskType } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { BottomBar, PrimaryButton } from '@/components/bottom-bar';
import { Card, SectionHeader, ChipAction } from '@/components/card';
import { CalendarPanel } from '@/components/calendar-panel';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { Input } from '@/components/input';
import { NoticeBanner } from '@/components/notice-banner';
import { HeaderAction, ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { LOAD_FULL_AT, type DayLoad } from '@/components/day-cell';
import { ScrollBody } from '@/components/scroll-body';
import { addDays, fmtFull, fmtMinutes, fmtMonthDay } from '@/lib/dates';
import { screenPadding, space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

const TYPES: TaskType[] = ['read', 'practice', 'project', 'review', 'assess'];
const TYPE_LABEL: Record<TaskType, string> = {
  read: '阅读',
  practice: '练习',
  project: '动手',
  review: '复习',
  assess: '自测',
};

const PRESETS = [15, 25, 45, 60, 90, 120];

/** 月历上「正在设定」的目标。一张月历两个用途，靠这个开关区分 */
type DateTarget = 'scheduledFor' | 'notBefore';

export default function TaskEditorScreen() {
  const router = useRouter();
  const { plan, today, apply, notice, dismissNotice, session, editProposal } = usePlanStore();
  const params = useLocalSearchParams<{ id?: string; day?: string; proposal?: string }>();

  /** 'new' 是新建。`/task/new` 会落到这条动态路由上（`id === 'new'`），
   *  所以不需要再建一个静态的 `new.tsx`，也就不存在静态/动态谁优先的问题 */
  const isNew = params.id === 'new' || !params.id;

  /**
   * 「改一张建议卡」模式。
   *
   * 带 `?proposal=<key>` 进来时，这一屏**不改计划**——它改的是会话里那张草稿卡。
   * 保存时写回会话（`editProposal`），学生回到复盘页再一起应用。
   *
   * 这样安排的理由：复盘的建议卡是「示例」，学生在上面改几个字，
   * 改完之后**还应该能整体看一眼再决定要不要**。直接改计划的话，
   * 每调一次卡片就产生一次写盘和一个版本。
   */
  const proposalKeyParam = params.proposal ?? null;
  const proposal = useMemo(
    () => (proposalKeyParam ? (session?.proposals.find((p) => proposalKey(p) === proposalKeyParam) ?? null) : null),
    [proposalKeyParam, session]
  );
  const inProposal = proposal !== null;

  const existing = useMemo(
    () => (isNew ? null : (plan?.tasks.find((t) => t.id === params.id) ?? null)),
    [isNew, plan, params.id]
  );

  /**
   * 草稿。**初值只取一次**（用 `useState` 的惰性初值）：
   * 如果跟着 `plan` 走，那么每敲一个字、每改一次计划都会把草稿重置回原值，
   * 学生根本改不完。
   *
   * 在建议卡模式下，初值是**建议之后的值**（不是任务现在的值）——
   * 学生打开卡片要看到的是「我打算把它改成这样」，然后在此基础上微调。
   * 这一条很容易做错，端到端里有专门的断言盯着。
   */
  const [draft, setDraft] = useState<TaskDraft>(() => {
    if (proposal?.kind === 'addTask') {
      return { ...blankDraft(proposal.task.scheduledFor), ...proposal.task };
    }
    if (proposal && existing) {
      const base = draftOf(existing);
      if (proposal.kind === 'reschedule') return { ...base, scheduledFor: proposal.scheduledFor };
      if (proposal.kind === 'estimate') return { ...base, estimateMin: proposal.estimateMin };
      if (proposal.kind === 'task') return { ...base, ...proposal.patch };
    }
    return existing ? draftOf(existing) : blankDraft(params.day ?? null);
  });
  const [target, setTarget] = useState<DateTarget>('scheduledFor');
  /** 月历在看哪个月。跟草稿里那两个日期无关，是纯界面状态 */
  const [month, setMonth] = useState(() => monthOf(draft.scheduledFor ?? today));
  /** 删除要两步确认。见下面那段注释 */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tags = useMemo(() => resolveTags(plan), [plan]);

  /** 有谁依赖这一项。删掉它之前必须说清楚 */
  const dependents = useMemo(
    () => (existing ? (plan?.tasks ?? []).filter((t) => t.dependsOn.includes(existing.id)) : []),
    [existing, plan]
  );

  /**
   * 可选的前置任务：**排除自己和自己的所有下游**。
   *
   * 不排除的话，选错就是一句「校验失败：dependsOn 存在环」——技术上是拦住了，
   * 但那是让学生去解一道他并不知道题面的题。这里直接把不可能的选择拿掉。
   */
  const candidateDeps = useMemo(() => {
    const all = plan?.tasks ?? [];
    if (!existing) return all;
    const banned = new Set<string>([existing.id]);
    // 沿 dependsOn 反查传递闭包：谁（直接或间接）等着我，谁就不能当我的前置
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of all) {
        if (banned.has(t.id)) continue;
        if (t.dependsOn.some((d) => banned.has(d))) {
          banned.add(t.id);
          grew = true;
        }
      }
    }
    return all.filter((t) => !banned.has(t.id));
  }, [existing, plan]);

  const unattached = useMemo(
    () => (plan?.resources ?? []).filter((r) => !draft.resourceIds.includes(r.id)),
    [plan, draft.resourceIds]
  );
  const attached = useMemo(
    () => draft.resourceIds.flatMap((id) => (plan?.resources ?? []).filter((r) => r.id === id)),
    [plan, draft.resourceIds]
  );

  /** 月历上的负载。没有它月历就只是一张日期表 */
  const loads = useMemo(() => {
    const map = new Map<string, DayLoad>();
    for (const tk of plan?.tasks ?? []) {
      if (!tk.scheduledFor || tk.id === existing?.id) continue;
      const cur = map.get(tk.scheduledFor);
      if (cur) {
        cur.minutes += tk.estimateMin;
        cur.total += 1;
      } else {
        map.set(tk.scheduledFor, {
          day: tk.scheduledFor,
          minutes: tk.estimateMin,
          done: 0,
          total: 1,
          isToday: tk.scheduledFor === today,
        });
      }
    }
    return map;
  }, [plan, today, existing]);

  const patch = existing ? taskPatch(existing, draft) : null;
  const titleOk = draft.title.trim().length > 0;
  const canSave = titleOk && (isNew || patch !== null);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const onSave = () => {
    /**
     * 建议卡模式：改的是**会话里的那张草稿卡**，不碰计划。
     *
     * 改完之后的种类一律变成 `task`（一次改好几个字段）。
     * 原来的「改期」「调时长」表达不了「我顺手把预估也调了」——
     * 而丢字段是这一类界面最经典的失败方式（界面上改了、应用后没变）。
     *
     * 理由也换掉：这条已经不是引擎的建议，而是学生自己的修改。
     * 留着引擎原文会误导——卡片上那行「理由由 AI 改写 · 原文」就说不通了。
     */
    if (proposal && proposalKeyParam) {
      const mine = { reason: '你自己改的', engineReason: '你自己改的' };
      if (proposal.kind === 'addTask') {
        editProposal(proposalKeyParam, {
          kind: 'addTask',
          task: {
            title: draft.title.trim(),
            type: draft.type,
            estimateMin: draft.estimateMin,
            notes: draft.notes,
            scheduledFor: draft.scheduledFor,
            notBefore: draft.notBefore,
            tags: draft.tags,
          },
          ...mine,
        });
      } else if ('taskId' in proposal && existing) {
        const patch = taskPatch(existing, draft) ?? {};
        editProposal(proposalKeyParam, { kind: 'task', taskId: proposal.taskId, patch, ...mine });
      }
      goBack();
      return;
    }

    if (isNew) {
      const id = newTaskId((plan?.tasks ?? []).map((t) => t.id));
      apply({
        type: 'task.add',
        task: {
          id,
          title: draft.title.trim(),
          type: draft.type,
          estimateMin: draft.estimateMin,
          tags: draft.tags,
          scheduledFor: draft.scheduledFor,
          // 学生自己排的日子要上锁（和 task.reschedule 的默认一致）
          pinned: draft.scheduledFor !== null,
          notBefore: draft.notBefore,
          dependsOn: draft.dependsOn,
          resourceIds: draft.resourceIds,
          notes: draft.notes,
        },
      });
      goBack();
      return;
    }
    if (!patch) return;
    apply({ type: 'task.edit', taskId: existing!.id, patch });
    goBack();
  };

  const onDelete = () => {
    if (!existing) return;
    apply({ type: 'task.remove', taskId: existing.id });
    goBack();
  };

  if (!plan) {
    return (
      <Screen>
        <ScreenHeader title="编辑任务" right={<HeaderAction label="返回" onPress={goBack} />} />
        <View style={{ paddingHorizontal: screenPadding }}>
          <AppText variant="body" tone="textMuted">
            计划还没读出来。
          </AppText>
        </View>
      </Screen>
    );
  }

  // 任务可能在编辑页打开之后被删掉了（另一屏删的）。明说，而不是渲染一张空表单
  if (!isNew && !existing) {
    return (
      <Screen>
        <ScreenHeader title="编辑任务" right={<HeaderAction label="返回" onPress={goBack} />} />
        <View style={{ paddingHorizontal: screenPadding }}>
          <EmptyState glyph="!" title="这一项已经不在了" body="它可能刚被删掉。回到上一屏看看。" />
        </View>
      </Screen>
    );
  }

  const dateValue = draft[target];

  return (
    <Screen>
      <ScreenHeader
        title={inProposal ? '改这张建议卡' : isNew ? '新任务' : '编辑任务'}
        // 不显示内部 id：学生认不出 t_rev_dp，而且别处也刻意不报内部 id
        meta={
          inProposal
            ? '改完回到复盘，还没写进计划'
            : isNew
              ? draft.scheduledFor
                ? `排到 ${fmtFull(draft.scheduledFor)}`
                : '放进待排池'
              : draft.scheduledFor
                ? `计划 v${plan.version} · 排在 ${fmtFull(draft.scheduledFor)}`
                : `计划 v${plan.version} · 待排池`
        }
        right={<HeaderAction label="返回" accessibilityLabel="不保存，返回" onPress={goBack} />}
      />

      <ScrollBody
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <NoticeBanner notice={notice} onDismiss={dismissNotice} />

        {/* ── 是什么 ───────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader>这张卡是什么</SectionHeader>
          <Card bordered style={styles.stack}>
            <AppText variant="caption" tone="textFaint">
              标题
            </AppText>
            <Input
              value={draft.title}
              onChangeText={(title) => setDraft((d) => ({ ...d, title }))}
              placeholder="比如：背包三变体回忆默写"
              // schema 的上限是 160。在这里就挡住，别等保存时才报错
              maxLength={160}
              accessibilityLabel="任务标题"
            />

            <AppText variant="caption" tone="textFaint">
              备注
            </AppText>
            <Input
              value={draft.notes}
              onChangeText={(notes) => setDraft((d) => ({ ...d, notes }))}
              placeholder="为什么这一条重要、要注意什么"
              multiline
              maxLength={2000}
              accessibilityLabel="任务备注"
            />

            <AppText variant="caption" tone="textFaint">
              类型
            </AppText>
            <View style={styles.chipRow}>
              {TYPES.map((ty) => (
                <Chip
                  key={ty}
                  tone="neutral"
                  selected={draft.type === ty}
                  accessibilityLabel={`类型改为${TYPE_LABEL[ty]}`}
                  onPress={() => setDraft((d) => ({ ...d, type: ty }))}
                >
                  {TYPE_LABEL[ty]}
                </Chip>
              ))}
            </View>

            <AppText variant="caption" tone="textFaint">
              标记
            </AppText>
            <View style={styles.chipRow}>
              {tags.map((tag) => {
                const on = draft.tags.includes(tag.id);
                return (
                  <Chip
                    key={tag.id}
                    tone={tag.tone}
                    selected={on}
                    accessibilityLabel={`${on ? '去掉' : '打上'}标记${tag.label}`}
                    onPress={() =>
                      setDraft((d) => ({
                        ...d,
                        tags: on ? d.tags.filter((x) => x !== tag.id) : [...d.tags, tag.id],
                      }))
                    }
                  >
                    {tag.label}
                  </Chip>
                );
              })}
            </View>
            <AppText variant="caption" tone="textFaint">
              标记是你自己打的，系统不会替你打，也不会因为标记改变排期（现在不会）。
            </AppText>
          </Card>
        </View>

        {/* ── 要多久 ───────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader>要多久</SectionHeader>
          <Card bordered style={styles.stack}>
            {/* 当前值用大字：微调的时候得能一眼看到现在是多少 */}
            <AppText variant="numeric">{fmtMinutes(draft.estimateMin)}</AppText>
            <View style={styles.chipRow}>
              {PRESETS.map((m) => (
                <Chip
                  key={m}
                  tone="neutral"
                  selected={draft.estimateMin === m}
                  accessibilityLabel={`预估改为 ${m} 分钟`}
                  onPress={() => setDraft((d) => ({ ...d, estimateMin: m }))}
                >
                  {m} 分钟
                </Chip>
              ))}
            </View>
            <View style={styles.stepperRow}>
              <ChipAction
                label={`− ${ESTIMATE_STEP}`}
                accessibilityLabel={`减少 ${ESTIMATE_STEP} 分钟`}
                onPress={() =>
                  setDraft((d) => ({
                    ...d,
                    estimateMin: Math.max(MIN_ESTIMATE_MIN, d.estimateMin - ESTIMATE_STEP),
                  }))
                }
              />
              <ChipAction
                label={`+ ${ESTIMATE_STEP}`}
                accessibilityLabel={`增加 ${ESTIMATE_STEP} 分钟`}
                onPress={() =>
                  setDraft((d) => ({
                    ...d,
                    estimateMin: Math.min(MAX_ESTIMATE_MIN, d.estimateMin + ESTIMATE_STEP),
                  }))
                }
              />
              <AppText variant="caption" tone="textFaint">
                档位之外的分钟数用这两个微调，不用打字
              </AppText>
            </View>
          </Card>
        </View>

        {/* ── 排在哪天 ─────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader
            right={
              <ChipAction
                label={target === 'scheduledFor' ? '正在设定：排期' : '正在设定：最早可安排日'}
                tone="accent"
                accessibilityLabel="切换这张月历在设定哪个日期"
                onPress={() => setTarget((x) => (x === 'scheduledFor' ? 'notBefore' : 'scheduledFor'))}
              />
            }
          >
            排在哪天
          </SectionHeader>

          <Card bordered style={styles.stack}>
            <AppText variant="label" tone={dateValue ? 'text' : 'textMuted'}>
              {target === 'scheduledFor'
                ? dateValue
                  ? `排在 ${fmtFull(dateValue)}`
                  : '还没排期（在待排池里）'
                : dateValue
                  ? `最早可安排到 ${fmtMonthDay(dateValue)}`
                  : '没有最早可安排日的限制'}
            </AppText>

            <View style={styles.chipRow}>
              {target === 'scheduledFor' ? (
                <>
                  <Chip
                    tone="neutral"
                    selected={draft.scheduledFor === today}
                    accessibilityLabel="排到今天"
                    onPress={() => setDraft((d) => withScheduledFor(d, today))}
                  >
                    今天
                  </Chip>
                  <Chip
                    tone="neutral"
                    selected={draft.scheduledFor === addDays(today, 1)}
                    accessibilityLabel="排到明天"
                    onPress={() => setDraft((d) => withScheduledFor(d, addDays(today, 1)))}
                  >
                    明天
                  </Chip>
                  <Chip
                    tone="neutral"
                    selected={draft.scheduledFor === null}
                    accessibilityLabel="放回待排池"
                    onPress={() => setDraft((d) => withScheduledFor(d, null))}
                  >
                    待排池
                  </Chip>
                </>
              ) : (
                <Chip
                  tone="neutral"
                  selected={draft.notBefore === null}
                  accessibilityLabel="取消最早可安排日"
                  onPress={() => setDraft((d) => ({ ...d, notBefore: null }))}
                >
                  不限
                </Chip>
              )}
            </View>

            {/* 一张月历服务两个字段，上面那个开关决定点下去写进哪个 */}
            <CalendarPanel
              month={month}
              selected={dateValue ?? draft.scheduledFor ?? today}
              today={today}
              loads={loads}
              fullAt={LOAD_FULL_AT}
              onMonthChange={setMonth}
              onSelect={(day) => {
                if (target === 'scheduledFor') setDraft((d) => withScheduledFor(d, day));
                else setDraft((d) => ({ ...d, notBefore: day }));
                if (!inMonth(day, month)) setMonth(monthOf(day));
              }}
            />

            {target === 'scheduledFor' ? (
              <View style={styles.chipRow}>
                <Chip
                  tone={draft.pinned ? 'accent' : 'neutral'}
                  selected={draft.pinned}
                  accessibilityLabel={draft.pinned ? '解锁，让引擎可以自动挪它' : '上锁，引擎不再自动挪它'}
                  onPress={() => setDraft((d) => ({ ...d, pinned: !d.pinned }))}
                >
                  {draft.pinned ? '已上锁' : '上锁'}
                </Chip>
                <AppText variant="caption" tone="textFaint" style={styles.hint}>
                  手动改期后引擎不再自动挪动它——你说过的话不该被系统改回去。
                </AppText>
              </View>
            ) : null}
          </Card>
        </View>

        {/* ── 等谁 ─────────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader>这项要等谁</SectionHeader>
          <Card bordered style={styles.stack}>
            {candidateDeps.length === 0 ? (
              <AppText variant="caption" tone="textFaint">
                计划里还没有别的任务可以当前置。
              </AppText>
            ) : (
              <View style={styles.chipRow}>
                {candidateDeps.map((t) => {
                  const on = draft.dependsOn.includes(t.id);
                  return (
                    <Chip
                      key={t.id}
                      tone={t.status === 'done' ? 'success' : 'neutral'}
                      selected={on}
                      accessibilityLabel={`${on ? '去掉前置' : '设为前置'}：${t.title}`}
                      onPress={() =>
                        setDraft((d) => ({
                          ...d,
                          dependsOn: on ? d.dependsOn.filter((x) => x !== t.id) : [...d.dependsOn, t.id],
                        }))
                      }
                    >
                      {t.title}
                    </Chip>
                  );
                })}
              </View>
            )}
            <AppText variant="caption" tone="textFaint">
              已经排在它后面的任务不在这里——选它会绕成一个环，计划会拒绝。
            </AppText>
          </Card>
        </View>

        {/* ── 资料 ─────────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader>资料</SectionHeader>
          <Card bordered style={styles.stack}>
            {attached.length === 0 ? (
              <AppText variant="caption" tone="textFaint">
                还没挂资料。
              </AppText>
            ) : (
              <View style={styles.chipRow}>
                {attached.map((r) => (
                  <Chip
                    key={r.id}
                    tone="accent"
                    selected
                    accessibilityLabel={`取消挂载 ${r.title}`}
                    onPress={() =>
                      setDraft((d) => ({ ...d, resourceIds: d.resourceIds.filter((x) => x !== r.id) }))
                    }
                  >
                    {r.title} ✕
                  </Chip>
                ))}
              </View>
            )}
            {unattached.length > 0 ? (
              <>
                <AppText variant="caption" tone="textFaint">
                  计划里还有这些，点一下就挂上：
                </AppText>
                <View style={styles.chipRow}>
                  {unattached.map((r) => (
                    <Chip
                      key={r.id}
                      tone="neutral"
                      accessibilityLabel={`挂上资料 ${r.title}`}
                      onPress={() => setDraft((d) => ({ ...d, resourceIds: [...d.resourceIds, r.id] }))}
                    >
                      {r.title}
                    </Chip>
                  ))}
                </View>
              </>
            ) : null}
            {/* 找新资料是工具调用（§8）那条链路的事。在这里再开一个入口，
                同一件事就会有两个去向 */}
            <AppText variant="caption" tone="textFaint">
              这里只能挂「资源」页里已经有的资料。想找新的，去资源页检索。
            </AppText>
          </Card>
        </View>

        {/* ── 危险 ─────────────────────────────────────────── */}
        {existing ? (
          <View style={styles.section}>
            <SectionHeader>删掉这一项</SectionHeader>
            <Card bordered style={styles.stack}>
              {dependents.length > 0 ? (
                <AppText variant="label" tone="warning">
                  有 {dependents.length} 项（{dependents.map((t) => t.title).join('、')}）以它为前置，
                  删掉之后那些前置会被自动清空。
                </AppText>
              ) : null}
              {/*
                两步确认，**刻意不用 `Alert`**：它在 react-native-web 上是空实现
                （`static alert() {}`），而本项目的截图和端到端验证全在 web 上跑，
                用它就等于「点了没反应」。
              */}
              <View style={styles.chipRow}>
                <Chip
                  tone={confirmDelete ? 'danger' : 'neutral'}
                  selected={confirmDelete}
                  accessibilityLabel={confirmDelete ? '确认删除这一项' : '删除这一项'}
                  onPress={() => {
                    if (confirmDelete) onDelete();
                    else setConfirmDelete(true);
                  }}
                >
                  {confirmDelete ? '真的删掉？' : '删除这一项'}
                </Chip>
                {confirmDelete ? (
                  <Chip tone="neutral" accessibilityLabel="取消删除" onPress={() => setConfirmDelete(false)}>
                    算了
                  </Chip>
                ) : null}
              </View>
            </Card>
          </View>
        ) : null}
      </ScrollBody>

      <BottomBar bottomInset={0}>
        <View style={styles.countBox}>
          {/*
            说不出「保存会做什么」的时候，把不能保存的原因说出来。
            一个灰掉的按钮不解释自己，看起来就像坏了。
          */}
          <AppText variant="caption" tone={titleOk ? 'textFaint' : 'warning'}>
            {!titleOk
              ? '标题不能是空的'
              : inProposal
                ? '改完回到复盘，还没写进计划'
                : isNew
                  ? '会新建一项'
                  : patch
                    ? `改了 ${Object.keys(patch).length} 处`
                    : '还没有改动'}
          </AppText>
          <AppText variant="subtitle">{isNew ? '新任务' : existing!.title}</AppText>
        </View>
        <PrimaryButton
          label={inProposal ? '存回这张卡' : '保存'}
          disabled={!canSave}
          onPress={onSave}
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
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  hint: {
    flex: 1,
    minWidth: 160,
  },
  countBox: {
    flex: 1,
  },
});
