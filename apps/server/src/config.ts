/**
 * 服务端配置：全部来自环境变量，且**不在日志或响应里泄露密钥**。
 */
export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
  timeoutMs?: number;
};

export type ServerConfig = {
  port: number;
  host: string;
  /** 未配置时为 null，此时所有 LLM 相关端点自动走降级路径 */
  llm: LlmConfig | null;
};

const LLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;

export type ConfigResult =
  | { ok: true; config: ServerConfig }
  | { ok: false; error: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `PORT 不是合法端口：${env.PORT}` };
  }

  const present = LLM_KEYS.filter((k) => env[k]?.trim());
  const missing = LLM_KEYS.filter((k) => !env[k]?.trim());

  let llm: LlmConfig | null = null;
  if (present.length === LLM_KEYS.length) {
    llm = {
      baseUrl: env.LLM_BASE_URL!.trim(),
      apiKey: env.LLM_API_KEY!.trim(),
      model: env.LLM_MODEL!.trim(),
      jsonMode: env.LLM_JSON_MODE === '1',
    };
  } else if (present.length > 0) {
    // 只配了一半是最容易踩的坑：服务能起来，但每个请求都降级，
    // 而日志里看不出来为什么。宁可启动就报错。
    return {
      ok: false,
      error: `LLM 配置不完整：缺少 ${missing.join(', ')}。要么三个都配，要么都不配（走降级路径）。`,
    };
  }

  return { ok: true, config: { port, host: env.HOST ?? '0.0.0.0', llm } };
}

/** 供 /health 展示用，不含 apiKey */
export function describeLlm(llm: LlmConfig | null): {
  configured: boolean;
  model?: string;
  baseUrl?: string;
  jsonMode?: boolean;
} {
  if (!llm) return { configured: false };
  return { configured: true, model: llm.model, baseUrl: llm.baseUrl, jsonMode: llm.jsonMode };
}
