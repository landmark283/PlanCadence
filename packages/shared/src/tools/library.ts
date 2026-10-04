/**
 * 内置资料库 —— 工具调用唯一的「事实来源」。
 *
 * ## 为什么是这份静态数据，而不是接一个搜索 API
 *
 * 因为**编 URL 就是撒谎**。模型的参数里记着一堆看起来像模像样的链接，
 * 其中相当一部分是死的或者错的；而 `Resource.url` 是要被学生点开的东西，
 * 点开是 404 比没有这条资源伤害大得多。
 *
 * 所以这一层的分工是：
 *   · **哪些资源存在** —— 静态库决定，每一条的 URL 都实际验证过（见 `LIBRARY_SNAPSHOT`）
 *   · **给谁推哪几条** —— `retrieve.ts` 的确定性打分决定，可测、可复现
 *   · **怎么描述** —— 模型可以润色，但它**不能新增资源**
 *
 * 想接真实检索时，扩展点是 `Resource.source`：把检索回来的结果标上自己的来源，
 * 和库里的条目并列展示，学生一眼能看出哪条是刚抓的、哪条是库里的。
 *
 * ## `verifiedAt` 在这份库里是"人工核对时间"，不是"刚刚抓取"
 *
 * 界面上那个字段原本是为「证明信息是刚抓的」设计的。库里这些条目**不是刚抓的**，
 * 所以：
 *   · `verifiedAt` 填 `LIBRARY_SNAPSHOT`，即这份清单最后一次被人工核对的日子
 *   · `source` 明确写成 `资料库快照@<日期>`
 * 卡片会显示「N 天前校验 · 来自 资料库快照@2026-10-19」，
 * 而实时抓回来的会是「今天校验 · 来自 codeforces.com/api」。
 * **两者必须能一眼区分开**——把静态数据说成实时数据，正是这个产品反对的那件事。
 */
import type { LearnerProfile } from '../llm/interview.ts';
import type { ResourceKind } from '../plan/schema.ts';

/** 与 `LearnerProfile['level']` 同一个类型，不另立一套（否则加了一档会悄悄漂开） */
export type Level = NonNullable<LearnerProfile['level']>;

/** 这份清单最后一次被人工核对的日期。库里所有条目的 `verifiedAt` 用它 */
export const LIBRARY_SNAPSHOT = '2026-10-19';

/** 库里条目的来源标识。和实时抓取回来的来源必须长得不一样 */
export const LIBRARY_SOURCE = `资料库快照@${LIBRARY_SNAPSHOT}`;

/**
 * 「这条是不是我们刚刚真的去抓的」——**只在这里定义**。
 *
 * 界面要靠它把「刚抓的」和「固定清单」分开显示，而这件事最容易写错的地方是
 * **用「不是快照」来推断「是实时」**：那样演示夹具里一条来自「校内通知」的
 * 静态数据也会被标成「实时」。两者是不同的判断，必须显式列出来。
 *
 * 新增一个实时数据源时，把它的 `source` 字符串加进来。
 */
export const LIVE_SOURCES: readonly string[] = ['codeforces.com/api'];

export function isLiveSource(source: string | null | undefined): boolean {
  return !!source && LIVE_SOURCES.includes(source);
}

/** 来源是不是内置资料库的快照 */
export function isSnapshotSource(source: string | null | undefined): boolean {
  return !!source && source.startsWith('资料库快照');
}

export type LibraryEntry = {
  id: string;
  title: string;
  url: string;
  kind: ResourceKind;
  /**
   * 这条资源**主要**讲什么。**必填**——它和 `tags` 不是一回事。
   *
   * 起因是一次真实的排序错误：查「动态规划」时，一门顺带覆盖 DP 的通用课程
   * 和 OI Wiki 的 DP 专页命中了同一个标签、得分打平，然后按 id 排序，
   * 泛泛的那条反而排在专页前面。光有 `tags` 区分不出「专门讲」和「顺便提到」，
   * 所以主题单独占一个字段，命中它有权重加成。
   */
  topic: string;
  /**
   * 匹配用的话题标签，**全部小写**。
   *
   * 中文标签直接就是学生会说的那个词（「动态规划」而不是「dp」），
   * 因为检索的输入是学生自述的薄弱点和任务标题，用的就是这些说法。
   * 英文缩写同时给一份，学生自己也可能写 DP / BFS。
   */
  tags: string[];
  /**
   * 最低适用水平。低于它的人拿到这条是浪费——给刚学语法的人推线段树题单，
   * 只会让他觉得"这系统不懂我"。
   */
  minLevel?: Level;
};

const L: LibraryEntry[] = [
  /* ── 通用入口 ─────────────────────────────────────────── */
  {
    id: 'res_oiwiki',
    topic: '算法',
    title: 'OI Wiki · 算法竞赛百科',
    url: 'https://oi-wiki.org/',
    kind: 'article',
    tags: ['算法', '基础', '入门', '竞赛', '模板', '数据结构'],
  },
  {
    id: 'res_visualgo',
    topic: '数据结构',
    title: 'VisuAlgo · 算法与数据结构可视化',
    url: 'https://visualgo.net/en',
    kind: 'tool',
    tags: ['可视化', '数据结构', '算法', '入门', '基础'],
  },
  {
    id: 'res_cpalgo',
    topic: '算法',
    title: 'CP-Algorithms · 算法实现手册',
    url: 'https://cp-algorithms.com/',
    kind: 'article',
    tags: ['算法', '图论', '动态规划', '字符串', '数论'],
    minLevel: 'basic',
  },

  /* ── 按知识点（OI Wiki 分册，链接都实际验证过）─────────── */
  {
    id: 'res_oiwiki_basic',
    topic: '基础',
    title: 'OI Wiki · 基础篇（枚举 / 排序 / 二分 / 贪心 / 前缀和）',
    url: 'https://oi-wiki.org/basic/',
    kind: 'article',
    tags: ['基础', '入门', '枚举', '模拟', '排序', '二分', '贪心', '前缀和', '差分'],
  },
  {
    id: 'res_oiwiki_dp',
    topic: '动态规划',
    title: 'OI Wiki · 动态规划',
    url: 'https://oi-wiki.org/dp/',
    kind: 'article',
    tags: ['动态规划', 'dp', '背包', '区间dp', '状压', '数位dp', '记忆化'],
  },
  {
    id: 'res_oiwiki_graph',
    topic: '图论',
    title: 'OI Wiki · 图论',
    url: 'https://oi-wiki.org/graph/',
    kind: 'article',
    tags: ['图论', '最短路', '并查集', '拓扑', '生成树', '二分图', 'tarjan', '网络流'],
  },
  {
    id: 'res_oiwiki_ds',
    topic: '数据结构',
    title: 'OI Wiki · 数据结构',
    url: 'https://oi-wiki.org/ds/',
    kind: 'article',
    tags: ['数据结构', '线段树', '树状数组', '堆', '栈', '队列', '平衡树', '链表'],
  },
  {
    id: 'res_oiwiki_search',
    topic: '搜索',
    title: 'OI Wiki · 搜索',
    url: 'https://oi-wiki.org/search/',
    kind: 'article',
    tags: ['搜索', 'dfs', 'bfs', '回溯', '剪枝', '双向搜索', '迭代加深'],
  },
  {
    id: 'res_oiwiki_string',
    topic: '字符串',
    title: 'OI Wiki · 字符串',
    url: 'https://oi-wiki.org/string/',
    kind: 'article',
    tags: ['字符串', 'kmp', '哈希', '后缀数组', 'ac自动机', 'manacher'],
  },
  {
    id: 'res_oiwiki_math',
    topic: '数学',
    title: 'OI Wiki · 数学',
    url: 'https://oi-wiki.org/math/',
    kind: 'article',
    tags: ['数学', '数论', '组合', '概率', '线性代数', 'gcd', '素数', '快速幂', '博弈'],
  },

  /* ── 题库与课程 ───────────────────────────────────────── */
  {
    id: 'res_luogu',
    topic: '题单',
    title: '洛谷 · 题单',
    url: 'https://www.luogu.com.cn/training/list',
    kind: 'problem_set',
    tags: ['题单', '练习', '刷题', '动态规划', '图论', '贪心', '二分', '基础'],
  },
  {
    id: 'res_cf_problemset',
    topic: '刷题',
    title: 'Codeforces · Problemset',
    url: 'https://codeforces.com/problemset',
    kind: 'problem_set',
    tags: ['练习', '刷题', '比赛', '动态规划', '图论', '贪心', '二分'],
    minLevel: 'basic',
  },
  {
    id: 'res_atcoder',
    topic: '比赛',
    title: 'AtCoder · 比赛归档',
    url: 'https://atcoder.jp/contests/archive',
    kind: 'problem_set',
    tags: ['比赛', '练习', '刷题', '动态规划', '图论'],
    minLevel: 'basic',
  },
  {
    id: 'res_nowcoder',
    topic: '比赛',
    title: '牛客 · 竞赛与题库',
    url: 'https://www.nowcoder.com/',
    kind: 'problem_set',
    tags: ['比赛', '练习', '笔试', '面试', '刷题'],
  },
  {
    id: 'res_leetcode',
    topic: '刷题',
    title: 'LeetCode 中国 · 题库',
    url: 'https://leetcode.cn/problemset/',
    kind: 'problem_set',
    tags: ['刷题', '数据结构', '动态规划', '面试', '基础'],
  },
  {
    id: 'res_acwing',
    topic: '课程',
    title: 'AcWing · 算法基础课',
    url: 'https://www.acwing.com/',
    kind: 'course',
    tags: ['课程', '基础', '入门', '算法', '动态规划', '图论'],
  },

  /* ── 赛事（本地库部分）───────────────────────────────── *
   * 这几条**刻意不给 deadline**。赛事报名截止日以官方公告为准，
   * 而我们没有任何可靠来源能拿到下一届的确切日期——写一个上去就是编。
   * 卡片会因此不显示倒计时，只给官网入口。
   * 真正带日期的是 `contest_feed` 从 Codeforces 实时拉回来的那批。
   */
  {
    id: 'res_contest_lanqiao',
    topic: '赛事',
    title: '蓝桥杯全国软件和信息技术专业人才大赛 · 官网',
    url: 'https://dasai.lanqiao.cn/',
    kind: 'contest',
    tags: ['蓝桥杯', '赛事', '比赛', '竞赛'],
  },
  {
    id: 'res_contest_ccpc',
    topic: '赛事',
    title: 'CCPC 中国大学生程序设计竞赛 · 官网',
    url: 'https://ccpc.io/',
    kind: 'contest',
    tags: ['ccpc', '赛事', '比赛', '组队'],
  },
  {
    id: 'res_contest_icpc',
    topic: '赛事',
    title: 'ICPC 国际大学生程序设计竞赛 · 官网',
    url: 'https://icpc.global/',
    kind: 'contest',
    tags: ['icpc', '赛事', '比赛', '组队'],
  },
];

export const LIBRARY: readonly LibraryEntry[] = L;

/** 一条都没匹配上时给的通用组合。宁可给宽泛的入口，也不要给一个空面板 */
export const FALLBACK_IDS: readonly string[] = ['res_oiwiki_basic', 'res_oiwiki', 'res_luogu', 'res_visualgo'];

const BY_ID = new Map(L.map((e) => [e.id, e]));

export function entryById(id: string): LibraryEntry | undefined {
  return BY_ID.get(id);
}
