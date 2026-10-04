/**
 * OpenAI 兼容协议的客户端。
 *
 * 「兼容 OpenAI」意味着只依赖 `/chat/completions` 这一个端点与它的基本请求/响应形状。
 * 刻意避开各家不一致的地方：
 *   · 不发 `response_format`（默认关，可用 jsonMode 打开）
 *   · 不发 `max_completion_tokens`（只有 OpenAI 新模型认，其余端点会 400）
 *   · 不依赖 `tool_calls` / `stream`，这些在兼容层里差异最大
 *
 * 因此它可以直接指向 DeepSeek、Moonshot、Qwen、本地 vLLM / Ollama 的兼容端点。
 */
import type { CompleteRequest, LlmProvider } from './provider.ts';

export type OpenAiCompatConfig = {
  /** 基础地址，含版本路径，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时，默认 60 秒 */
  timeoutMs?: number;
  /** 是否发送 response_format: {type:'json_object'}。部分兼容端点不支持，默认关闭。 */
  jsonMode?: boolean;
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string };
};

/** 去掉结尾斜杠，避免拼出 `//chat/completions` */
const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function createOpenAiCompatProvider(cfg: OpenAiCompatConfig): LlmProvider {
  const url = `${trimSlash(cfg.baseUrl)}/chat/completions`;
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  const doFetch = cfg.fetchImpl ?? fetch;

  return {
    name: `openai-compat:${cfg.model}`,

    async complete(req: CompleteRequest): Promise<string> {
      // 手写超时而不是用 AbortSignal.timeout：后者在 Hermes 上不保证存在，
      // 而这一层要和移动端共享。
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: req.messages,
      };
      // 只发有值的可选参数：有些兼容端点对显式 null / 默认值会报错
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      if (cfg.jsonMode) body.response_format = { type: 'json_object' };

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        const err = e as Error;
        if (err.name === 'AbortError') {
          throw new Error(req.signal?.aborted ? '请求已取消' : `请求超时（${timeoutMs} ms）`);
        }
        throw new Error(`无法连接到 ${cfg.baseUrl}：${err.message}`);
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }

      const text = await res.text();

      if (!res.ok) {
        // 把响应体前一段带出来——兼容端点的报错信息质量参差，
        // 但「model not found」「invalid api key」这类关键信息通常就在开头。
        throw new Error(`HTTP ${res.status}：${text.slice(0, 500)}`);
      }

      let json: ChatCompletionResponse;
      try {
        json = JSON.parse(text) as ChatCompletionResponse;
      } catch {
        throw new Error(`响应不是合法 JSON：${text.slice(0, 300)}`);
      }

      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        // 空 content 最常见的原因是内容被安全策略拦截，或 finish_reason=length 被截断
        const reason = json.choices?.[0]?.finish_reason ?? json.error?.message ?? '未知';
        throw new Error(`模型返回了空内容（finish_reason=${reason}）`);
      }
      return content;
    },
  };
}
