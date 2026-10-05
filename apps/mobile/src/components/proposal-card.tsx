/**
 * 建议卡片 —— 复盘和「跟 AI 说说」共用的那一张。
 *
 * ## 它承载的是「帮你把卡片写好」这件事
 *
 * 卡片上三层：**改的是谁**（标题）、**从什么变成什么**（change）、**为什么**（理由）。
 * 学生要做的不是「从零写一张卡」，而是看这三层，然后
 * 〔编辑〕改几个字、或者划掉不要。
 *
 * ## 两个动作是分开的两个控件，不是一个
 *
 * 左边勾选框 = 要不要这条；右边〔编辑〕= 打开编辑页微调。
 * **不做「点整张卡打开编辑」**：那样勾选框就必须嵌在里面，
 * 而 `Pressable` 套 `Pressable` 在 web 上点击会冒泡、在原生上靠 responder 系统，
 * 两边行为不一致（这是 v0.3 在任务卡上踩过的坑，解法同样是让它们做兄弟）。
 *
 * ## 划掉之后不是消失，是变暗
 *
 * 卡片留在原地、整体变暗。消失的话学生没法反悔（要重新开一次会话才能拿回来），
 * 而变暗 + 划掉状态是可逆的——底部那个「已选 N 张」也才能对得上。
 */
import { StyleSheet, View } from 'react-native';
import { describeProposal } from '@sp/shared';
import type { PlanFile, Proposal } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card, ChipAction } from '@/components/card';
import { CheckControl } from '@/components/check-control';
import { Chip } from '@/components/chip';
import { space } from '@/theme';

export type ProposalCardProps = {
  proposal: Proposal;
  /** 用来查任务标题。查不到也要画得出来（任务可能刚被删） */
  plan: PlanFile;
  /** 要不要这条（没被划掉） */
  kept: boolean;
  /** 学生改过这一条。由调用方比对 origin 得出 */
  edited?: boolean;
  onToggle: () => void;
  onEdit: () => void;
};

export function ProposalCard({ proposal, plan, kept, edited = false, onToggle, onEdit }: ProposalCardProps) {
  const row = describeProposal(proposal, plan);
  const rewritten = row.reason !== row.engineReason;

  return (
    <Card tone={kept ? 'surface' : 'sunken'} bordered>
      <View style={styles.head}>
        <CheckControl
          checked={kept}
          accessibilityLabel={kept ? `不要「${row.title}」这条建议` : `保留「${row.title}」这条建议`}
          onToggle={onToggle}
        />

        <View style={styles.body}>
          <View style={styles.titleRow}>
            <AppText variant="subtitle" tone={kept ? 'text' : 'textFaint'} style={styles.title}>
              {row.title}
            </AppText>
            <ChipAction
              label="编辑"
              accessibilityLabel={`编辑这条建议：${row.title}`}
              onPress={onEdit}
            />
          </View>

          {/* 从什么变成什么。学生一眼要能看出这条到底动什么 */}
          <AppText variant="label" tone={kept ? 'primary' : 'textFaint'}>
            {row.change}
          </AppText>

          <AppText variant="label" tone="textMuted">
            {row.reason}
          </AppText>

          {/* 理由被 AI 改写时把原文也摆出来：让「AI 只是把话说得更好懂、
              决定仍然是引擎做的」这件事在界面上可见（§7.0.2） */}
          {rewritten ? (
            <AppText variant="caption" tone="textFaint">
              理由由 AI 改写 · 原文：「{row.engineReason}」
            </AppText>
          ) : null}

          {edited ? <Chip tone="neutral">你改过</Chip> : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  body: {
    flex: 1,
    gap: space.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  title: {
    flex: 1,
  },
});
