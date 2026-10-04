/**
 * 工具调用的 HTTP 端点（§8）。
 *
 * ## 为什么这两个端点只有薄薄一层
 *
 * 真正的逻辑全在 `@sp/shared` 的 `tools/` 里——资料库是静态的、检索是确定性的、
 * 挂到任务是纯计算。放在共享层的好处是：**移动端断网时用的是同一份代码**，
 * 不存在的"两端排序规则悄悄不一致"这类问题。
 *
 * 这里只做两件事：
 *   1. 参数校验（zod，和别的路由一致）
 *   2. `contests` 那个**真的去网上拿**——这是唯一必须留在服务端的能力
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attachPlanResources, localContestFeed, searchResources } from '@sp/shared';
// 只能当类型用：Node 的类型剥离**不删**被当成值导入的类型，
// 于是 `import { Level }` 会在运行时抛 "does not provide an export named 'Level'"，
// 而 tsc 因为是按类型解析的、不会报错。必须写成 import type
import type { Level, Resource } from '@sp/shared';
import { fetchCodeforcesContests } from '../tools/codeforces.ts';

const LevelSchema = z.enum(['beginner', 'basic', 'intermediate', 'advanced']);

const SearchBody = z.object({
  /** 检索文本。学生自述的薄弱点、任务标题，或他自己敲的一句话 */
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
  level: LevelSchema.nullish(),
  exclude: z.array(z.string().max(64)).max(50).optional(),
  /** 一条都没命中时是否退回通用入口组，默认 true */
  fallback: z.boolean().optional(),
});

const ContestsBody = z.object({
  /** 演示时钟的今天，用来过滤已开赛的场次 */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(10).optional(),
  /** false 时完全不碰网络，只用本地库——弱网下客户端可以主动降级 */
  live: z.boolean().optional(),
});

/** 给后端做依据的档案片段。只要这几项，不需要整份 LearnerProfile */
const PlanBody = z.object({
  weakSpots: z.array(z.string().max(40)).max(12).default([]),
  level: LevelSchema.nullish(),
  goalStatement: z.string().max(500).nullish(),
  tasks: z.array(z.object({ id: z.string().max(64), title: z.string().max(200) })).max(60).default([]),
  exclude: z.array(z.string().max(64)).max(80).optional(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  live: z.boolean().optional(),
});

export function registerToolRoutes(app: FastifyInstance): void {
  /**
   * 按一段文本检索资料。**纯本地**，不碰网络，所以永远不会失败。
   */
  app.post('/tools/resources', async (req, reply) => {
    const body = SearchBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const { query, limit, level, exclude, fallback } = body.data;
    const hits = searchResources(query, {
      ...(limit !== undefined ? { limit } : {}),
      level: (level ?? null) as Level | null,
      ...(exclude ? { exclude } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
    });

    return {
      ok: true as const,
      query,
      queries: [query],
      resources: hits.map((h) => h.resource),
      /** 命中了哪些词。界面要能如实告诉学生「我按什么找的」 */
      matched: hits.map((h) => h.matched),
      source: '资料库',
    };
  });

  /**
   * 赛事日程。
   *
   * `live` 为假时完全不碰网络；为真（默认）时先试实时接口，
   * **失败就退回本地库**，并且把原因写在 `note` 里返回——
   * 学生看到的"没有实时赛程"必须有个说法，不能是空白。
   */
  app.post('/tools/contests', async (req, reply) => {
    const body = ContestsBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const { today, limit, live } = body.data;

    const local = localContestFeed().map((h) => h.resource);
    if (live === false) {
      return { ok: true as const, resources: local, source: '资料库快照', note: '客户端要求只用本地库', live: false };
    }

    const fetched = await fetchCodeforcesContests({
      ...(limit !== undefined ? { limit } : {}),
      ...(today ? { today } : {}),
    });
    if (!fetched.contests.length) {
      req.log.warn({ note: fetched.note }, 'contest feed unavailable, using local library only');
      return { ok: true as const, resources: local, source: '资料库快照', note: fetched.note, live: false };
    }

    // 实时的那批排在前面，本地官网入口跟在后面
    return {
      ok: true as const,
      resources: [...fetched.contests, ...local],
      source: fetched.source,
      note: fetched.note,
      live: true,
    };
  });

  /**
   * 一次给一份计划挂上资料（含实时赛事）。
   *
   * 移动端在"生成计划"之后、以及学生自己点「找资料」时调用它。
   * 返回的是**指令**（resources + links），由客户端走 `plan.attachResources`
   * 命令写回计划——服务端不持有状态，这一条和别的端点是一样的。
   */
  app.post('/tools/attach', async (req, reply) => {
    const body = PlanBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const { weakSpots, level, goalStatement, tasks, exclude, today, live } = body.data;

    let extra: Resource[] = [];
    let note = '只用本地资料库';
    if (live !== false) {
      const fetched = await fetchCodeforcesContests({ ...(today ? { today } : {}) });
      extra = fetched.contests;
      note = fetched.note;
    }

    const out = attachPlanResources({
      tasks,
      profile: {
        weakSpots,
        level: (level ?? null) as Level | null,
        goalStatement: goalStatement ?? null,
      },
      ...(exclude ? { exclude } : {}),
      extra,
    });

    return {
      ok: true as const,
      resources: out.resources,
      links: out.links,
      queries: out.queries,
      note,
      /** 里面有没有实时抓回来的条目，客户端据此说话 */
      live: extra.length > 0,
    };
  });
}
