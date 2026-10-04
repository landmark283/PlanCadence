/**
 * 任务状态的展示映射。
 *
 * 集中放在这里，而不是各屏各写一份 if/else：状态枚举有 5 个值，
 * 分散之后必然出现「今日页叫卡住、复盘页叫阻塞」这种不一致。
 */
import type { TaskStatus, TaskType } from '@sp/shared';

import type { ChipTone } from '@/components/chip';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  skipped: '已跳过',
  blocked: '卡住了',
};

export const STATUS_TONE: Record<TaskStatus, ChipTone> = {
  todo: 'neutral',
  doing: 'accent',
  done: 'success',
  skipped: 'neutral',
  blocked: 'warning',
};

export const TYPE_LABEL: Record<TaskType, string> = {
  read: '阅读',
  practice: '练习',
  project: '动手',
  review: '复习',
  assess: '自测',
};

/** 改预估时长用的预设档位。刻意是离散档位而不是自由输入：
 *  学生估不准是常态，给几个「合理的数」比给一个空输入框有用 */
export const ESTIMATE_PRESETS = [15, 25, 45, 60, 90, 120] as const;

/** 状态选择器的顺序。done 不在这里——完成只走勾选框，避免两个入口改同一个状态 */
export const SELECTABLE_STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked', 'skipped'];
