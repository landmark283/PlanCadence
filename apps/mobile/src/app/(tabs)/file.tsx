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
import { exportBaseName, toIcs, toMarkdown } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { PrimaryButton } from '@/components/bottom-bar';
import { Card, SectionLabel } from '@/components/card';
import { Chip, type ChipTone } from '@/components/chip';
import { ScreenHeader } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { DEMO_PLAN_TEXT } from '@/fixtures/demo-plan';
import { copyText } from '@/lib/clipboard';
import { useOfflineOnly, setOfflineOnly } from '@/lib/demo-mode';
import { deliverTextFile } from '@/lib/export-file';
import { PLAN_ID, usePlanStore, useStorageInfo, type SaveStatus } from '@/state/plan-store';
import { planStorage } from '@/storage/plan-storage';
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
  const { plan, planText, save, loadError, installPlan, forceOverwrite, retryLoad, notify, today } = usePlanStore();
  const info = useStorageInfo();
  const status = SAVE_LABEL[save.status];
  const offlineOnly = useOfflineOnly();

  /**
   * 版本快照列表。
   *
   * 每次变更都会留下**上一版的整份快照**（`saveWithSnapshot` 写的）。
   * 回滚走快照而不是重放命令：重放要求命令永久向后兼容，代价高且容易错。
   * 把数量显示出来，一是让「可回滚」这件事可见，二是顺带证明存储适配器的
   * `listSnapshots` 真的在工作——它是最容易写成空实现的一个方法。
   */
  const [snapshots, setSnapshots] = useState<number[]>([]);
  useEffect(() => {
    let alive = true;
    void planStorage.listSnapshots(PLAN_ID).then((v) => {
      if (alive) setSnapshots(v);
    });
    return () => {
      alive = false;
    };
    // 版本变了或刚写完盘，快照列表都可能变
  }, [plan?.version, save.status]);

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
          <SectionLabel>版本快照 · {snapshots.length} 个</SectionLabel>
          <Card bordered style={styles.stack}>
            {snapshots.length > 0 ? (
              <View style={styles.row}>
                {snapshots.map((v) => (
                  <Chip key={v} tone="neutral">
                    v{v}
                  </Chip>
                ))}
              </View>
            ) : (
              <AppText variant="label" tone="textMuted">
                还没有快照。第一次改动之后就会出现——每次变更都留下上一版的整份内容。
              </AppText>
            )}
            <AppText variant="caption" tone="textFaint">
              回滚走快照，不走命令重放：重放要求命令永久向后兼容，代价高且容易错。
              文件只有几十 KB，不值得为省这点空间冒那个风险。
            </AppText>
            <View style={styles.actionRow}>
              <AppText
                variant="label"
                tone="primary"
                accessibilityRole="button"
                accessibilityLabel="查看版本历史并回滚"
                onPress={() => router.push('/history')}
                suppressHighlighting
                style={styles.textAction}
              >
                查看版本历史
              </AppText>
            </View>
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
              切到复盘页直接就有偏差和调整可讲，不用现场攒。
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
