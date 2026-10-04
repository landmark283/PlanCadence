/**
 * 操作反馈条。
 *
 * 存在的理由：命令层会**拒绝**某些操作（例如前置任务没完成就不许标记完成），
 * 这正是「计划能被机器校验」这个卖点最直接的证据。如果把它静默吞掉，
 * 界面上就只剩「点了没反应」——卖点变成了 bug。
 *
 * 成功反馈同样显示：它让「每一次操作都经过命令层」这件事可见。
 */
import { Pressable, StyleSheet } from 'react-native';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import type { Notice } from '@/state/plan-store';
import { space } from '@/theme';

export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  if (!notice) return null;
  const error = notice.tone === 'error';

  return (
    <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" onPress={onDismiss}>
      {/* 失败要显眼（描边 + 危险色），成功要安静（不画边框），
          否则每打一个勾都弹一条同样重量的提示，反而变噪音 */}
      <Card tone={error ? 'surface' : 'sunken'} bordered={error} style={styles.card}>
        <AppText variant="caption" tone={error ? 'danger' : 'success'}>
          {error ? '没有执行' : '已更新'}
        </AppText>
        <AppText variant="label" tone="textMuted">
          {notice.text}
        </AppText>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: space.md,
  },
});
