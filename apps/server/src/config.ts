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
  /**
   * `SP_TODAY=2026-10-19` —— 把整台服务端的时间**冻结在这一天**。
   *
   * 为什么服务端也需要这个开关：演示和调试时「今天」必须和示例计划对得上，
   * 而真实日期和示例计划差着两周。以前这件事是靠**客户端**养一个假时钟做的，
   * 于是同一个「今天」在系统里有了三个来源（客户端常量、服务端的两份 nowStamp、
   * `codeforces.ts` 里的 `Date.now()`），互相矛盾。
   *
   * 现在把它挪到服务端，变成一个显式的、有文档的启动参数。
   * 不设 = 真实时间。
   */
  today: string | null;
  /** `SP_TZ`，默认 Asia/Shanghai。算「今天」用；不参与任何时刻的存储 */
  tz: string;
};

const LLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;

export type ConfigResult =
  | { ok: true; config: ServerConfig }
  | { ok: false; error: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const tz = env.SP_TZ?.trim() || 'Asia/Shanghai';
  // 时区写错不能等到算「今天」的时候才炸——那时它会以一个看不懂的
  // RangeError 出现在某个请求里，而不是在启动时。和 LLM 配置同样的原则：宁可启动就报错。
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { ok: false, error: `SP_TZ 不是合法的时区名：${tz}（例：Asia/Shanghai）` };
  }

  const today = env.SP_TODAY?.trim() || null;
  if (today && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return { ok: false, error: `SP_TODAY 必须形如 2026-10-19，实际是：${today}` };
  }
  if (today && new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10) !== today) {
    return { ok: false, error: `SP_TODAY 不是一个真实存在的日期：${today}` };
  }

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

  return { ok: true, config: { port, host: env.HOST ?? '0.0.0.0', llm, today, tz } };
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
