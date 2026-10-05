/**
 * 计划文件页 —— 「这是自定义格式，可读、可手改」这句话的物质证据。
 *
 * 刻意做成一个**标签页**而不是藏在二级入口里：
 * 答辩时评委要看的是文件本身，而不是一段关于文件的描述。
 *
 * 这里显示的 `planText` 是**设备上那份文件的原文**，不是内存里重新序列化的结果。
 * 这一点由 store 保证：每次写完都会立刻读回来，读回来的和写下去的对不上就报错，
 * 不会把「刚序列化出来的字符串」冒充成盘上的内容。两者只在出错时才有差别，
 * 而那时差别很重要：保存失败时这一页必须显示磁盘上的旧内容，
 * 而不是一个"看起来已经存好了"的新版本。
 */
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { addDays, describeProfile, exportBaseName, isDay, missingProfileFields, toIcs, toMarkdown } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { PrimaryButton } from '@/components/bottom-bar';
import { Card, SectionLabel } from '@/components/card';
import { Chip, type ChipTone } from '@/components/chip';
import { Input } from '@/components/input';
import { ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { DEMO_PLAN_TEXT } from '@/fixtures/demo-plan';
import { copyText } from '@/lib/clipboard';
import { useOfflineOnly, setOfflineOnly } from '@/lib/demo-mode';
import { deliverTextFile } from '@/lib/export-file';
import { PLAN_ID, usePlanStore, useStorageInfo, type SaveStatus } from '@/state/plan-store';
import { screenPadding, space } from '@/theme';

/** 文件大小。中文一个字三字节，所以按 UTF-8 算而不是 `text.length` */
function byteSize(text: string): string {
  let bytes = text.length;
  try {
    bytes = new TextEncoder().encode(text).length;
  } catch {
    // Hermes 上 TextEncoder 不保证存在，退回按字符粗略估算
    bytes = text.length * 2;
  }
  return bytes < 1024 ? `${bytes} 字节` : `${(bytes / 1024).toFixed(1)} KB`;
}

const SAVE_LABEL: Record<SaveStatus, { text: string; tone: ChipTone }> = {
  idle: { text: '尚未写入', tone: 'neutral' },
  saving: { text: '正在写入…', tone: 'warning' },
  saved: { text: '已保存到设备', tone: 'success' },
  error: { text: '保存失败', tone: 'danger' },
  blocked: { text: '已暂停写入', tone: 'danger' },
};

export default function FileScreen() {
  const router = useRouter();
  const {
    plan,
    planText,
    profile,
    save,
    loadError,
    installPlan,
    forceOverwrite,
    retryLoad,
    notify,
    today,
    realToday,
    clockSource,
    clockSetting,
    setClock,
    simulateDaysLater,
  } = usePlanStore();
  const info = useStorageInfo();
  const status = SAVE_LABEL[save.status];
  const offlineOnly = useOfflineOnly();
  // 缺哪几项是给「访谈做了一半」用的：档案在，但还说不出目标或截止日。
  // 没有档案时不显示它——那时该说的是「做过访谈就有了」，不是列一串缺项。
  const missing = profile ? missingProfileFields(profile) : [];

  /**
   * 固定日期的输入草稿。
   *
   * 必须有一份本地草稿：学生打字的过程中每一次按键都会产生一个「还不合法」的
   * 中间状态（`2026-1`），如果每次都直接写进设置，时钟会在打字打到一半时
   * 被改成一个非法值。所以草稿和生效值是分开的，只有真的合法才提交。
   */
  const [dateDraft, setDateDraft] = useState(clockSetting.date ?? '');
  useEffect(() => {
    setDateDraft(clockSetting.date ?? '');
  }, [clockSetting.date]);

  const commitDate = () => {
    if (isDay(dateDraft)) setClock({ mode: 'debug', date: dateDraft });
  };

  /**
   * 导出。
   *
   * 生成（`toMarkdown` / `toIcs`）在 `@sp/shared` 里，是纯函数、有测试盯着；
   * 投递（写文件 / 触发下载）按平台分文件。这里只负责串起来并把结果说出来。
   *
   * 为什么这件事不是加分项：`.studyplan` 是自定义格式，而自定义格式最大的风险
   * 就是**变成数据孤岛**——学生没法把它带进日历、也没法贴给同学。
   */
  const runExport = async (kind: 'md' | 'ics') => {
    if (!plan) return;
    const at = new Date().toISOString();
    const base = exportBaseName(plan, today);
    const spec =
      kind === 'md'
        ? { filename: `${base}.md`, mime: 'text/markdown', content: toMarkdown(plan, { at }) }
        : { filename: `${base}.ics`, mime: 'text/calendar', content: toIcs(plan, { at }) };

    const res = await deliverTextFile(spec.filename, spec.mime, spec.content);
    notify(res.ok ? { tone: 'success', text: res.note } : { tone: 'error', text: `导出失败：${res.error}` });
  };

  return (
    <Screen>
      <ScreenHeader
        title="计划文件"
        meta={plan ? `${PLAN_ID} · v${plan.version} · ${byteSize(planText)}` : '读取中…'}
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 读不出文件时不覆盖，先把话说清楚。
            两种失败的处理相反：内容不合法时给「覆盖」按钮（学生的编辑在里面，
            不能替他扔）；存储本身坏掉时给「重试」按钮（覆盖没用，写不进去）。 */}
        {loadError ? (
          <Card bordered style={styles.stack}>
            <AppText variant="caption" tone="danger" style={styles.eyebrow}>
              {loadError.kind === 'parse' ? '文件内容读不出来' : '存储不可用'}
            </AppText>
            <AppText variant="label" tone="textMuted">
              {loadError.message}
            </AppText>
            <AppText variant="caption" tone="textFaint">
              {loadError.kind === 'parse'
                ? '这个格式本来就是给人改的，手改出错很正常。系统不会替你把改动抹掉——要么按提示改回文件，要么明确地选择用当前计划覆盖它。'
                : '这是存储层的问题，和文件内容无关，改文件没有用。计划现在只在内存里，退出应用就会丢。'}
            </AppText>
            <View style={styles.actionRow}>
              {loadError.kind === 'parse' ? (
                <PrimaryButton label="用当前计划覆盖文件" onPress={forceOverwrite} />
              ) : (
                <PrimaryButton label="重试" onPress={retryLoad} />
              )}
            </View>
          </Card>
        ) : null}

        <View style={styles.section}>
          <SectionLabel>存储位置</SectionLabel>
          <Card bordered style={styles.stack}>
            <View style={styles.row}>
              <Chip tone="accent">{info?.backend ?? '…'}</Chip>
              <Chip tone={status.tone}>{status.text}</Chip>
            </View>
            <AppText variant="caption" tone="textMuted" style={styles.mono}>
              {info?.root ?? ''}
            </AppText>
            <AppText variant="caption" tone="textFaint">
              {info?.hint ?? ''}
            </AppText>
            {save.message ? (
              <AppText variant="caption" tone="danger">
                {save.message}
              </AppText>
            ) : null}
            <AppText variant="caption" tone="textFaint">
              每次改动都会在 versions/ 里留一份上一版的完整内容。文件只有几十 KB，
              留一份不心疼；真出了事，那份文件是可以直接打开手动恢复的。
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionLabel>学生档案</SectionLabel>
          <Card bordered style={styles.stack} testID="student-profile">
            <View style={styles.row}>
              <Chip tone={profile ? 'accent' : 'neutral'}>{profile ? '已随文件保存' : '还没有档案'}</Chip>
              {profile && missing.length ? <Chip tone="warning">还缺 {missing.length} 项</Chip> : null}
            </View>

            {profile ? (
              <>
                <AppText variant="label">{profile.goalStatement ?? '（没写目标）'}</AppText>
                <AppText variant="caption" tone="textMuted">
                  {describeProfile(profile) || '（档案是空的，访谈只开了个头）'}
                </AppText>
              </>
            ) : (
              <AppText variant="label" tone="textMuted">
                这份计划里没有档案。做过一次访谈之后它就写进来了——「跟 AI 说说」和找资料
                都靠它知道你是谁，而不是从任务表反推。
              </AppText>
            )}

            <AppText variant="caption" tone="textFaint">
              它住在文件正文里（`profile:` 开头那一段），不是存在这台设备上：重开 App 它还在，
              换设备、把文件发给同学，上下文也跟着走。
            </AppText>
            <AppText variant="caption" tone="textFaint">
              档案读不出来时只当没有，不会让整份计划读不出来——文件里你亲手写的任务
              比一段背景描述重要得多。
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionLabel>
            文件内容 · {planText ? planText.split('\n').length : 0} 行 · 只读预览
          </SectionLabel>
          <Card tone="sunken" bordered>
            <AppText variant="caption" tone="textMuted" style={[styles.mono, styles.code]}>
              {planText || '（正在从设备读取…）'}
            </AppText>
          </Card>
          <AppText variant="caption" tone="textFaint">
            开头几行是格式说明，程序写入时也会保留。手工编辑请保持 schema / id / version 三个字段不变。
          </AppText>
        </View>

        <View style={styles.section}>
          <SectionLabel>时间</SectionLabel>
          <Card bordered style={styles.stack}>
            <View style={styles.row}>
              <Chip tone={clockSource === 'server' ? 'accent' : 'neutral'} selected={clockSetting.mode === 'live'}>
                {clockSource === 'setting'
                  ? `固定 ${clockSetting.date ?? '—'}`
                  : clockSource === 'server'
                    ? `跟随服务器 · ${today}`
                    : `本机时间 · ${today}`}
              </Chip>
              {clockSetting.mode === 'debug' ? <Chip tone="warning">调试模式</Chip> : null}
            </View>

            <AppText variant="caption" tone="textMuted">
              今天是 {today}。
              {clockSource === 'server'
                ? '这个日期由服务端给出——客户端不自己做 UTC 到本地日期的换算，那件事最容易在深夜算错一天。'
                : clockSource === 'setting'
                  ? `调试模式下日期不会自己走：设了哪天就一直是哪天。真实的今天是 ${realToday}。`
                  : '没连上服务端，用的是本机时间。'}
            </AppText>

            <View style={styles.row}>
              <Chip
                tone={clockSetting.mode === 'live' ? 'accent' : 'neutral'}
                selected={clockSetting.mode === 'live'}
                accessibilityLabel="时间跟随服务器"
                onPress={() => setClock({ mode: 'live', date: null })}
              >
                跟随服务器
              </Chip>
              <Chip
                tone={clockSetting.mode === 'debug' ? 'accent' : 'neutral'}
                selected={clockSetting.mode === 'debug'}
                accessibilityLabel="时间固定在指定日期"
                onPress={() =>
                  // 第一次切到调试模式时用「今天」当起点，否则学生得先自己想一个日期
                  setClock({ mode: 'debug', date: clockSetting.date ?? today })
                }
              >
                固定日期
              </Chip>
            </View>

            {clockSetting.mode === 'debug' ? (
              <>
                {/*
                  任意日期输入。做完快捷档位就收工是不够的——
                  「想设定成哪天就是哪天」是调试模式的全部意义，
                  而快捷档位只能往前走几天，回不到上个月，也回不到明年。
                */}
                <Input
                  value={dateDraft}
                  onChangeText={setDateDraft}
                  onBlur={commitDate}
                  onSubmitEditing={commitDate}
                  placeholder="2026-10-19"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="固定日期，格式为年-月-日"
                  returnKeyType="done"
                />
                <View style={styles.row}>
                  {[0, 1, 3, 5, 7].map((d) => (
                    <Chip
                      key={d}
                      tone="neutral"
                      // d = 0 用的是**真实的**今天，不是被固定的那个「今天」——
                      // 否则这个档位在调试模式下是个原地打转的空操作
                      accessibilityLabel={d === 0 ? '固定日期改为今天' : `固定日期改为 ${d} 天后`}
                      onPress={() => setClock({ mode: 'debug', date: addDays(d === 0 ? realToday : today, d) })}
                    >
                      {d === 0 ? '今天' : `+${d} 天`}
                    </Chip>
                  ))}
                </View>
                {dateDraft && !isDay(dateDraft) ? (
                  <AppText variant="caption" tone="warning">
                    日期要写成 2026-10-19 这样，而且必须真实存在。
                  </AppText>
                ) : null}
              </>
            ) : null}

            <AppText variant="caption" tone="textFaint">
              演示和调试需要「今天就是某一天」，真实使用需要「今天就是今天」，这两个要求是互斥的。
              所以它是一个显式的二选一，而不是一段藏在代码里的常量。
            </AppText>
          </Card>

          <Card bordered style={styles.stack}>
            <View style={styles.actionRow}>
              <Chip
                tone="neutral"
                accessibilityLabel="模拟隔了五天回来"
                onPress={() => void simulateDaysLater(5)}
              >
                模拟隔了 5 天回来
              </Chip>
            </View>
            <AppText variant="caption" tone="textFaint">
              把调试日期推到 5 天后、同时把「上次打开」拨回今天，然后立刻结一次账。
              演示当天没法真的等一天，而这个按钮同时也在这条链路的测试入口上——
              一个按钮同时服务演示和验证，比造两个入口好，它们不会各自跑偏。
            </AppText>
          </Card>
        </View>

        {/* ── 导出 ──────────────────────────────────────────── *
            自定义格式最大的风险是变成数据孤岛：学生没法把它带进日历、
            也没法贴给同学。所以导出不是加分项，是让这个格式选择站得住脚的条件。 */}
        <View style={styles.section}>
          <SectionLabel>导出</SectionLabel>
          <Card bordered style={styles.stack}>
            <View style={styles.row}>
              <Chip tone="neutral" onPress={() => void runExport('md')} accessibilityLabel="导出 Markdown">
                Markdown
              </Chip>
              <Chip tone="neutral" onPress={() => void runExport('ics')} accessibilityLabel="导出日历">
                日历 .ics
              </Chip>
              <Chip
                tone="neutral"
                accessibilityLabel="复制文件内容"
                onPress={() =>
                  void copyText(planText).then((ok) =>
                    notify(
                      ok
                        ? { tone: 'success', text: `已复制 ${planText.split('\n').length} 行文件内容` }
                        : { tone: 'error', text: '这个环境不让写剪贴板（浏览器要求 https 或 localhost）' },
                    ),
                  )
                }
              >
                复制文件内容
              </Chip>
            </View>
            <AppText variant="caption" tone="textFaint">
              Markdown 给人和聊天窗口看；.ics 导进手机日历，每个已排期任务是一个全天事项，
              赛事截止会提前一天提醒。日历事件用全天而不是具体时刻——计划里只有日期，
              没有开始时间，替你编一个时间是错的。
            </AppText>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionLabel>演示用</SectionLabel>
          <Card bordered style={styles.stack}>
            <AppText variant="label" tone="textMuted">
              把计划重置回仓库里的示例文件（examples/demo.studyplan）。演示前想回到干净状态时用。
              这份示例本身就是一个可演示的状态：里面已经有一条耗时超预估的任务，
              在今日页点〔复盘〕直接就有偏差和调整可讲，不用现场攒。
            </AppText>
            <View style={styles.actionRow}>
              <AppText
                variant="label"
                tone="primary"
                accessibilityRole="button"
                accessibilityLabel="重置为示例计划"
                onPress={() => installPlan(DEMO_PLAN_TEXT, '已重置为示例计划')}
                suppressHighlighting
                style={styles.textAction}
              >
                重置为示例计划
              </AppText>
            </View>
            {/*
              「重做访谈」放在这里而不是今日页：它是个**演示/开发**动作
              （学生不会想再做一遍访谈），原来占着今日页右上角那个位置，
              把真正属于用户的动作（复盘）挤掉了。
            */}
            <View style={styles.actionRow}>
              <AppText
                variant="label"
                tone="primary"
                accessibilityRole="button"
                accessibilityLabel="重新做一次访谈"
                onPress={() => router.push('/onboarding')}
                suppressHighlighting
                style={styles.textAction}
              >
                重做访谈
              </AppText>
            </View>
          </Card>

          {/* 演示保险。它防的不是断网（断网会立刻失败并降级），
              而是"网通着但 API 连不上"——那种情况会一直等到 90 秒超时 */}
          <Card bordered style={styles.stack}>
            <View style={styles.row}>
              <Chip
                tone={offlineOnly ? 'accent' : 'neutral'}
                selected={offlineOnly}
                accessibilityLabel={offlineOnly ? '关闭演示模式，允许联网调用模型' : '打开演示模式，只用本机'}
                onPress={() => setOfflineOnly(!offlineOnly)}
              >
                {offlineOnly ? '演示模式：已开启' : '打开演示模式'}
              </Chip>
            </View>
            <AppText variant="caption" tone="textFaint">
              打开之后一次网络请求都不发，访谈、生成、复盘全部走本机逻辑，速度是毫秒级。
              关掉时才会去调模型。
            </AppText>
            <AppText variant="caption" tone="textFaint">
              要防的不是"断网"——断网会立刻失败并在几毫秒内退回本机，那是安全的。
              会出事的是"网通着但模型 API 连不上"：那时请求不会立刻失败，而是一路等到超时，
              生成计划那条的超时是 90 秒。台上等 90 秒比"答得不好"严重得多。
            </AppText>
          </Card>
        </View>
      </ScrollView>
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
  /** Card 内部的竖向间距。Card 默认 gap 是 sm，这里要松一点 */
  stack: {
    gap: space.md,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  actionRow: {
    flexDirection: 'row',
    marginTop: space.xs,
  },
  textAction: {
    paddingVertical: space.md,
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  code: {
    // caption 的字号 + 等宽 + 略紧的行高，像一份真的文件预览而不是一段正文
    lineHeight: 17,
  },
  eyebrow: {
    letterSpacing: 0.6,
  },
});
