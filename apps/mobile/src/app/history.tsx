/**
 * 版本历史与回滚。
 *
 * ## 这一页补的是「快照已经存了，但没人够得着」
 *
 * 每次变更都会把**上一版的整份原文**写进 `versions/`，命令层的 `plan.restore`
 * 也早就可用——但界面上一直没有入口，于是这些快照等于不存在。
 * 一个学生永远点不到的功能，和没做是一样的。
 *
 * ## 为什么回滚要两步确认，而不是弹 Alert
 *
 * `Alert` 在 react-native-web 上没有实现（四屏里一处都没用它，原因相同）。
 * 而且回滚虽然可逆（回滚前那一版也会被快照下来），它毕竟是把学生**看得见的**
 * 进度换掉——点错一下心里会咯噔。所以做成行内两步：先点「回滚」，按钮变成
 * 「确认回滚到 v3」，再点才真的执行。
 *
 * ## 为什么快照里的内容也列出来
 *
 * 只给一个版本号，学生没法判断该回哪一版。所以每条都显示**那时候的样子**：
 * 更新时间、任务数、已完成数、目标原话，还能展开看原始文件。
 * 这正是"快照存的是整份原文"这个设计换来的好处——不用重放命令就能还原。
 */
import { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/app-text';
import { Card, SectionLabel } from '@/components/card';
import { Chip } from '@/components/chip';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader, HeaderAction } from '@/components/screen-header';
import { Screen } from '@/components/screen';
import { fmtFull } from '@/lib/dates';
import { screenPadding, space } from '@/theme';
import { usePlanStore, type PlanVersion } from '@/state/plan-store';

/** ISO 时间戳 → '10月19日 周一 21:45'。版本列表里比完整时间戳好读 */
function fmtStamp(iso: string | null): string {
  if (!iso) return '时间未知';
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${fmtFull(day)} ${time}` : iso;
}

export default function HistoryScreen() {
  const router = useRouter();
  const { plan, listVersions, restoreTo } = usePlanStore();
  const [versions, setVersions] = useState<PlanVersion[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  /** 已经点过一次「回滚」、等着确认的那一版 */
  const [confirming, setConfirming] = useState<number | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    void listVersions().then((v) => {
      if (alive) setVersions(v);
    });
    return () => {
      alive = false;
    };
  }, [listVersions]);

  // 回滚之后当前版本会变，列表要跟着刷新——否则你会看到"回滚成功但列表没动"
  useEffect(() => reload(), [reload, plan?.version]);

  const current = plan?.version ?? 0;

  return (
    <Screen>
      <ScreenHeader
        title="版本历史"
        meta={versions ? `${versions.length} 个历史版本 · 当前 v${current}` : '读取中…'}
        right={<HeaderAction label="返回" accessibilityLabel="返回计划文件页" onPress={() => router.back()} />}
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card bordered style={styles.stack}>
          <AppText variant="label" tone="textMuted">
            每次改动都会把上一版的整份原文存下来。回滚走的是快照，不是重放命令——
            重放要求命令永久向后兼容，代价高且容易错。
          </AppText>
          <AppText variant="caption" tone="textFaint">
            回滚本身也是一次前进：它会产生一个新版本，而回滚前的那一版同样会被存下来，
            所以回滚之后还能再滚回来。
          </AppText>
        </Card>

        <View style={styles.section}>
          <SectionLabel>当前 · v{current}</SectionLabel>
          <Card bordered style={styles.stack}>
            <AppText variant="subtitle" numberOfLines={2}>
              {plan?.goal.statement ?? '（读不到计划）'}
            </AppText>
            <View style={styles.row}>
              <Chip tone="accent">正在使用</Chip>
              <Chip tone="neutral">{plan?.tasks.length ?? 0} 个任务</Chip>
              <Chip tone="neutral">{plan?.tasks.filter((t) => t.status === 'done').length ?? 0} 项已完成</Chip>
            </View>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionLabel>历史版本{versions?.length ? ` · ${versions.length} 个` : ''}</SectionLabel>

          {versions === null ? (
            <AppText variant="label" tone="textFaint">
              正在从设备读取快照…
            </AppText>
          ) : versions.length === 0 ? (
            <EmptyState
              glyph="○"
              title="还没有历史版本"
              body="第一次改动之后就会出现——每次变更都会把上一版整份存下来。"
            />
          ) : (
            <View style={styles.list}>
              {versions.map((v) => (
                <Card key={v.version} bordered style={styles.stack}>
                  <View style={styles.row}>
                    <Chip tone="neutral">v{v.version}</Chip>
                    <AppText variant="caption" tone="textFaint">
                      {fmtStamp(v.updated)}
                    </AppText>
                  </View>

                  {v.broken ? (
                    <AppText variant="label" tone="warning">
                      这一版读不出来：{v.broken}
                    </AppText>
                  ) : (
                    <>
                      <AppText variant="label" tone="textMuted" numberOfLines={2}>
                        {v.goalStatement}
                      </AppText>
                      <View style={styles.row}>
                        <Chip tone="neutral">{v.taskCount} 个任务</Chip>
                        <Chip tone="neutral">{v.doneCount} 项已完成</Chip>
                      </View>
                    </>
                  )}

                  <View style={styles.actions}>
                    <AppText
                      variant="label"
                      tone="textMuted"
                      accessibilityRole="button"
                      accessibilityLabel={`${openId === v.version ? '收起' : '查看'} v${v.version} 的文件内容`}
                      onPress={() => setOpenId((cur) => (cur === v.version ? null : v.version))}
                      suppressHighlighting
                      style={styles.textAction}
                    >
                      {openId === v.version ? '收起内容' : '查看内容'}
                    </AppText>

                    {v.broken ? null : (
                      <AppText
                        variant="label"
                        tone="primary"
                        accessibilityRole="button"
                        accessibilityLabel={
                          confirming === v.version ? `确认回滚到 v${v.version}` : `回滚到 v${v.version}`
                        }
                        onPress={() => {
                          if (confirming !== v.version) {
                            setConfirming(v.version);
                            return;
                          }
                          setConfirming(null);
                          void restoreTo(v.version).then((ok) => {
                            if (ok) router.back();
                          });
                        }}
                        suppressHighlighting
                        style={styles.textAction}
                      >
                        {confirming === v.version ? `确认回滚到 v${v.version}` : '回滚到这一版'}
                      </AppText>
                    )}
                  </View>

                  {openId === v.version ? (
                    <Card tone="sunken" bordered>
                      <AppText variant="caption" tone="textMuted" style={[styles.mono, styles.code]}>
                        {v.text}
                      </AppText>
                    </Card>
                  ) : null}
                </Card>
              ))}
            </View>
          )}
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
  list: {
    gap: space.sm,
  },
  stack: {
    gap: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.lg,
  },
  textAction: {
    paddingVertical: space.md,
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  code: {
    lineHeight: 17,
  },
});
