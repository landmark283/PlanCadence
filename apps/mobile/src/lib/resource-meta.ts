/** 资源类型的展示映射。和 task-meta 一样集中一处，避免各屏说法不一致 */
import type { ResourceKind } from '@sp/shared';

export const KIND_LABEL: Record<ResourceKind, string> = {
  article: '文章',
  video: '视频',
  course: '课程',
  book: '书籍',
  problem_set: '题单',
  contest: '赛事',
  tool: '工具',
};

/** 从 URL 里取主机名。不用 `new URL()`：RN 的 URL 实现历史上不完整，
 *  这里只需要去掉协议和路径，正则反而更可靠 */
export function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? url;
}
