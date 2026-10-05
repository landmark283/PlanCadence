/**
 * 操作反馈条。
 *
 * 存在的理由：命令层会**拒绝**某些操作（例如前置任务没完成就不许标记完成），
 * 这正是「计划能被机器校验」这个卖点最直接的证据。如果把它静默吞掉，
 * 界面上就只剩「点了没反应」——卖点变成了 bug。
 *
 * 成功反馈同样显示：它让「每一次操作都经过命令层」这件事可见。
 *
 * ## 撤销为什么挂在这里
 *
 * 「跟 AI 说说」/ 复盘应用之后，这条通知上多一个〔撤销〕。
 * 挂在这里是因为**它的有效期正好就是这条通知的有效期**：学生接着做了别的事，
 * 通知被下一条替换，撤销也就跟着消失。
 *
 * 这不是版本管理，是**一次动作的反悔权**——边界就是「紧接着的这一次」。
 * 用整份快照恢复（`plan.restore`）而不是算反向命令：删任务的反向要恢复
 * 任务快照和别人的前置引用，容易漏，而快照恢复是现成的、有测试的。
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { ChipAction } from '@/components/card';
import type { Notice } from '@/state/plan-store';
import { space } from '@/theme';

export function NoticeBanner({
  notice,
  onDismiss,
  onUndo,
}: {
  notice: Notice | null;
  onDismiss: () => void;
  /** 有值时才显示〔撤销〕。见上面那段「撤销为什么挂在这里」 */
  onUndo?: () => void;
}) {
  if (!notice) return null;
  const error = notice.tone === 'error';

  return (
    // 整条可点 = 关掉它。有了撤销按钮之后就不能再让整条可点了，
    // 否则点撤销会连带把通知关掉（两个动作抢同一个手势，v0.3 吃过这个亏）
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="关闭提示"
      onPress={onUndo ? undefined : onDismiss}
    >
      {/* 失败要显眼（描边 + 危险色），成功要安静（不画边框），
          否则每打一个勾都弹一条同样重量的提示，反而变噪音 */}
      <Card tone={error ? 'surface' : 'sunken'} bordered={error} style={styles.card}>
        <AppText variant="caption" tone={error ? 'danger' : 'success'}>
          {error ? '没有执行' : '已更新'}
        </AppText>
        <AppText variant="label" tone="textMuted">
          {notice.text}
        </AppText>
        {onUndo ? (
          <View style={styles.row}>
            <ChipAction label="撤销" accessibilityLabel="撤销刚才这次改动" onPress={onUndo} />
            <AppText variant="caption" tone="textFaint">
              只对刚才这一次有效；你再动一下它就不在了
            </AppText>
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xs,
  },
});
