/**
 * 「规划相关的提醒」——计划自己和自己打架的地方。
 *
 * ## 为什么抽成一个组件
 *
 * 今日页和复盘页**都要有这一块**（学生可能在两处中的任何一处发现自己计划里的矛盾），
 * 而同一件事在两处措辞不同是最容易被一眼看穿的拼装感。所以只有一份实现，
 * 两处各渲染一次。
 *
 * ## 数据是现算的，没有存进 store
 *
 * `validatePlan(plan)` 是纯函数，警告永远由**当前这份计划**推出来。
 * store 里曾经有一个 `warnings: string[]` 字段，删掉了——它是第二份真相：
 * 计划一变就得记得同步，迟早会有一屏显示着上一版计划的问题。
 *
 * ## key 不能只用 `path`（这里踩过一次）
 *
 * 一项任务**同时**可以触发好几条警告：排期落在不可用区间、排在总截止日之后、
 * 排在它自己那条线的截止日之后。它们的 `path` 全是 `task:t_xx`，
 * 拿它当 React key 会撞（`Encountered two children with the same key`）。
 * 这个项目的复盘页已经因为「拿警告文本当 key」炸过一次，所以这里用
 * 下标 + 路径：这一列是静态的、不重排、每一项也无状态，下标是安全且唯一的。
 */
import { useMemo } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { validatePlan, type PlanFile } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card, SectionHeader } from '@/components/card';
import { space } from '@/theme';

export function PlanWarnings({ plan, style }: { plan: PlanFile; style?: ViewProps['style'] }) {
  const warnings = useMemo(() => validatePlan(plan).filter((i) => i.level === 'warn'), [plan]);
  if (!warnings.length) return null;

  return (
    <View style={[styles.section, style]}>
      <SectionHeader>提醒 · {warnings.length} 条</SectionHeader>
      <Card bordered style={styles.stack}>
        {warnings.map((w, i) => (
          <AppText key={`${w.path}#${i}`} variant="label" tone="textMuted">
            · {w.message}
          </AppText>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: space.md,
  },
  stack: {
    gap: space.sm,
  },
});
