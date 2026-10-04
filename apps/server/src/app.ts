/**
 * 应用装配。与 listen 分开，是为了让测试能用 `app.inject()`
 * 在不占端口、不起进程的情况下打真实路由。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { LlmProvider } from '@sp/llm-client';
import type { ServerConfig } from './config.ts';
import { registerPlanRoutes } from './routes/plan.ts';
import { registerInterviewRoutes } from './routes/interview.ts';
import { registerToolRoutes } from './routes/tools.ts';

export type BuildAppOptions = {
  /** 测试里传 false 静音日志 */
  logger?: boolean;
};

export async function buildApp(
  _config: ServerConfig,
  provider: LlmProvider | null,
  opts: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // 移动端在开发期通过局域网访问，必须放开跨域。
  // 生产环境应改成白名单——这里留着 TODO 是因为比赛版就一个 App，不引入配置复杂度。
  await app.register(cors, { origin: true });

  registerPlanRoutes(app, provider);
  registerInterviewRoutes(app, provider);
  registerToolRoutes(app);

  return app;
}
