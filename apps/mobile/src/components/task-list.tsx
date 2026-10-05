/**
 * 任务列表 —— 今日页和日历页共用的一段。
 *
 * ## 为什么抽出来
 *
 * 这段逻辑原本内联在今日页里（`renderTask` 那个闭包）。日历页要显示
 * 「选中那天的任务」，如果照着抄一份，就会得到两段几乎一样的 JSX——
 * 而这个项目已经吃过这个亏：任务卡和待排池当初就是这样分头演化的，
 * 结果是「改了其中一处、另一处忘了改」。
 *
 * ## `animateNextLayout` 也一起搬进来了
 *
 * 改预估或改状态都可能让引擎把任务挪到别的日子，那时卡片会从当前列表里消失、
 * 后面的卡片往上补位。不做动画的话这一步是「啪」地跳一下，而「系统自动重排」
 * 恰恰是我们要让学生看见的事。它原本只在今日页有；搬进来之后日历页自动也有。
 *
 * ## 资料和前置从 `plan` 里现查
 *
 * 不要求调用方先拼好两个 Map：那两份 Map 是同一件事的第二个实现，
 * 而且调用方漏传一个就会静默少显示一块（资料 chip 或前置提示）。
 * id 找不到就跳过——资源可能被删了，而这不该让整张卡炸掉。
 */
import { View, StyleSheet } from 'react-native';
import { tagsOf } from '@sp/shared';
import type { PlanFile, Task } from '@sp/shared';

import { EmptyState } from '@/components/empty-state';
import { TaskCard } from '@/components/task-card';
import { animateNextLayout } from '@/lib/layout-animation';
import { space } from '@/theme';
import { usePlanStore } from '@/state/plan-store';

export type TaskListProps = {
  tasks: Task[];
  /** 前置、资料、标记都从这份计划里查 */
  plan: PlanFile;
  /** 待排池里的任务用下沉面，与已排期的区分开 */
  variant?: 'scheduled' | 'backlog';
  /** 同时只展开一张卡：展开多张之后，一屏又变回按钮墙 */
  expandedId: string | null;
  onToggleExpand: (id: string | null) => void;
  /** 进编辑页。长按卡片和点「编辑这一项」都会走它 */
  onOpenEditor: (taskId: string) => void;
  /**
   * 空的时候显示什么。不传就什么都不画——
   * 有些位置（待排池）空着本来就不该出现。
   */
  empty?: { glyph: string; title: string; body: string };
};

export function TaskList({
  tasks,
  plan,
  variant = 'scheduled',
  expandedId,
  onToggleExpand,
  onOpenEditor,
  empty,
}: TaskListProps) {
  const { apply } = usePlanStore();

  if (tasks.length === 0) {
    return empty ? (
      <EmptyState glyph={empty.glyph} title={empty.title} body={empty.body} />
    ) : null;
  }

  /** 所有会改动排期的命令都从这里走，理由见文件头 */
  const applyRescheduling = (cmd: Parameters<typeof apply>[0]) => {
    animateNextLayout();
    apply(cmd);
  };

  return (
    <View style={styles.list}>
      {tasks.map((tk) => (
        <TaskCard
          key={tk.id}
          task={tk}
          variant={variant}
          resources={tk.resourceIds.flatMap((rid) => {
            const r = plan.resources.find((x) => x.id === rid);
            return r ? [r] : [];
          })}
          // 认不出来的标记 id 在这里就被丢掉：卡片拿到的都是画得出来的
          tags={tagsOf(plan, tk.tags)}
          deps={
            variant === 'backlog'
              ? []
              : tk.dependsOn.flatMap((id) => {
                  const d = plan.tasks.find((x) => x.id === id);
                  return d ? [{ id: d.id, title: d.title, done: d.status === 'done' }] : [];
                })
          }
          expanded={expandedId === tk.id}
          onToggleExpand={() => onToggleExpand(expandedId === tk.id ? null : tk.id)}
          onOpenEditor={() => onOpenEditor(tk.id)}
          onToggleDone={() => {
            const next = tk.status === 'done' ? 'todo' : 'done';
            applyRescheduling({ type: 'task.setStatus', taskId: tk.id, status: next });
            // 刚打勾时顺手把卡展开：紧接着要问「实际用了多久」，
            // 而那是引擎判断超前/落后的唯一输入
            onToggleExpand(next === 'done' ? tk.id : null);
          }}
          onSetStatus={(status) => applyRescheduling({ type: 'task.setStatus', taskId: tk.id, status })}
          onSetEstimate={(estimateMin) => applyRescheduling({ type: 'task.setEstimate', taskId: tk.id, estimateMin })}
          onSetActual={(actualMin) =>
            applyRescheduling({ type: 'task.setStatus', taskId: tk.id, status: 'done', actualMin })
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: space.sm,
  },
});
