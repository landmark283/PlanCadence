/**
 * 应用装配。与 listen 分开，是为了让测试能用 `app.inject()`
 * 在不占端口、不起进程的情况下打真实路由。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { LlmProvider } from '@sp/llm-client';
import type { ServerConfig } from './config.ts';
import { createServerClock, type ServerClock } from './clock.ts';
import { registerPlanRoutes } from './routes/plan.ts';
import { registerInterviewRoutes } from './routes/interview.ts';
import { registerToolRoutes } from './routes/tools.ts';
import { registerTimeRoutes } from './routes/time.ts';
import { registerSettleRoutes } from './routes/settle.ts';
import { registerTalkRoutes } from './routes/talk.ts';

export type BuildAppOptions = {
  /** 测试里传 false 静音日志 */
  logger?: boolean;
};

export async function buildApp(
  config: ServerConfig,
  provider: LlmProvider | null,
  opts: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // 移动端在开发期通过局域网访问，必须放开跨域。
  // 生产环境应改成白名单——这里留着 TODO 是因为比赛版就一个 App，不引入配置复杂度。
  await app.register(cors, { origin: true });

  /**
   * 全服务唯一的时钟，从这里往下传。
   *
   * 以前每个路由各抄一份 `nowStamp()`、`codeforces` 直接读 `Date.now()`，
   * 于是同一个「今天」有四个来源，并且真的已经矛盾过一次
   * （演示日期是 2026-10-19，赛程却按真实的 2026-10-04 过滤）。
   */
  const clock: ServerClock = createServerClock(config);

  registerPlanRoutes(app, provider, clock);
  registerInterviewRoutes(app, provider, clock);
  registerToolRoutes(app, clock);
  registerTimeRoutes(app, clock);
  registerSettleRoutes(app, provider);
  registerTalkRoutes(app, provider, clock);

  return app;
}
