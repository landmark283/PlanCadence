/**
 * 来源徽标 —— 「这段话/这道题是 AI 给的本机给的」。
 *
 * ## 为什么要有它，以及为什么它必须能展开
 *
 * 产品底线：**「这个结果是 AI 给的还是本机算法给的」永远看得见。**
 * 但现在的做法是把原因直接摆在学生正在答题的位置——
 * 「没连上服务端（请求超时（25 秒）），用本机题库继续」。它很诚实，
 * 可它出现在学生答题的地方，读起来像出错了。
 *
 * 所以：平时只显示一个不起眼的小标，**点一下才展开那句话**。
 * 变的是它不再打断人，不是它被藏起来。
 *
 * ## 为什么默认收起
 *
 * 「降级的原因」在正常流程里是**噪音**：学生不关心为什么这次是本机给的，
 * 他只关心题出得对不对。而在他真的怀疑「今天这题怎么这么差」的时候，
 * 那个原因必须一戳就有。
 *
 * ## 四处复用
 *
 * 访谈出题、复盘方向、协商结果，以及将来任何「模型参与过」的地方。
 * 一处实现，四处说法一致——不会出现「访谈页叫 AI 出题、复盘页叫模型综述」。
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Chip } from '@/components/chip';
import { space } from '@/theme';

export type BadgeSource = 'llm' | 'local' | null;

export type SourceBadgeProps = {
  source: BadgeSource;
  /** 退化原因或补充说明（「模型重试 1 次后通过」这类）。空/`ok` 就不显示 */
  note?: string | null;
  /** 点开之后那句解释。不传就用 `note` */
  detail?: string;
  /** AI 那一边的说明。不传用一句通用的 */
  llmLabel?: string;
};

export function SourceBadge({ source, note, detail, llmLabel }: SourceBadgeProps) {
  const [open, setOpen] = useState(false);
  if (!source) return null;

  const isAi = source === 'llm';
  const reason = detail ?? (note && note !== 'ok' ? note : '');
  const explain =
    reason ||
    (isAi ? (llmLabel ?? '这一条是 AI 参与生成的。') : '这一条由本机规则算出来（不依赖网络）。');

  return (
    <View style={styles.wrap}>
      <Chip
        tone={isAi ? 'accent' : 'neutral'}
        accessibilityLabel={
          open
            ? `收起来源说明（${isAi ? 'AI' : '本机'}）`
            : `这一条来自${isAi ? 'AI' : '本机'}，点开看原因`
        }
        onPress={() => setOpen((x) => !x)}
      >
        {isAi ? 'AI' : '本机'}
      </Chip>
      {open ? (
        <AppText variant="caption" tone="textFaint" style={styles.explain}>
          {explain}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.xs,
  },
  explain: {
    flexShrink: 1,
  },
});
