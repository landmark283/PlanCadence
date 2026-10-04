/**
 * 服务端入口。
 *
 * 运行方式刻意用 `node src/index.ts` 而不是 tsx：
 * Node 22.19 自带类型剥离，且 workspace 包经 pnpm 符号链接解析后 realpath
 * 落在 packages/ 而非 node_modules 内，因此不受「node_modules 内不剥离类型」限制。
 */
import { createOpenAiCompatProvider } from '@sp/llm-client';
import { loadEnvFile } from '@sp/env-node';
import { buildApp } from './app.ts';
import { describeLlm, loadConfig } from './config.ts';

// 必须在 loadConfig 之前：配置就是从 process.env 读的。
// 从 cwd 向上查找，所以 `pnpm --filter @sp/server start`（cwd=apps/server）
// 和从根目录 `node apps/server/src/index.ts` 都能找到仓库根的 .env。
const envInfo = loadEnvFile();

const loaded = loadConfig();
if (!loaded.ok) {
  console.error(`✕ ${loaded.error}`);
  process.exit(1);
}
const config = loaded.config;

const provider = config.llm
  ? createOpenAiCompatProvider({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      jsonMode: config.llm.jsonMode,
    })
  : null;

const app = await buildApp(config, provider);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    // 这个提示值得写清楚：端口被占用时，请求会打到旧进程上，
    // 于是「你明明改了代码却没生效」，排查方向很容易跑偏。
    console.error(`✕ 端口 ${config.port} 已被占用。`);
    console.error('  最常见的原因：上一次启动的服务还在运行，请先关掉它。');
    console.error(`  或者换端口：在 .env 里加一行 PORT=8899`);
  } else {
    console.error(`✕ 服务启动失败：${(e as Error).message}`);
  }
  process.exit(1);
}

const llm = describeLlm(config.llm);
console.log(`[server] http://127.0.0.1:${config.port}`);
console.log(
  envInfo.path
    ? `[server] 配置来源：${envInfo.path}`
    : '[server] 未找到 .env，使用进程环境变量（可复制 .env.example 为 .env）'
);
console.log(
  llm.configured
    ? `[server] LLM: ${llm.model} @ ${llm.baseUrl}${llm.jsonMode ? '（jsonMode）' : ''}`
    : '[server] LLM: 未配置 —— /plan/review 会自动走引擎措辞（降级路径）'
);
