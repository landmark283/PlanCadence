/**
 * LLM 提供方抽象 + 结构化输出工具。
 *
 * 刻意不依赖任何 SDK：需求是「必须兼容 OpenAI 协议」，而各家兼容端点的
 * `response_format` 支持程度不一致，SDK 的 provider 专有结构化输出反而成为负担。
 * 「提示词约束 + 防御性 JSON 提取 + zod 校验 + 带着错误重试」这套在任何端点上都能工作，
 * 而且它本来就必须要写——模型的 JSON 输出从来不会 100% 干净。
 *
 * 这一层不碰网络细节（那是 openai.ts 的事），只负责：
 *   1. 定义 provider 契约
 *   2. 把模型输出里的 JSON 抠出来
 *   3. 校验失败时把错误回灌给模型重试
 */
import type { ZodType } from 'zod';

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type CompleteRequest = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export interface LlmProvider {
  /** 用于日志与错误信息，如 'openai-compat:deepseek-chat' */
  readonly name: string;
  /** 返回模型输出的原始文本。失败必须抛错，不要返回空串。 */
  complete(req: CompleteRequest): Promise<string>;
}

/* ------------------------------------------------------------------ *
 * JSON 提取
 * ------------------------------------------------------------------ */

/** 零宽字符与 BOM：模型偶尔会带出来，肉眼看不见但会让 JSON.parse 失败 */
const INVISIBLE = /[\u200B-\u200D\uFEFF]/g;
const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string };

function tryParse(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 从模型输出里抠出 JSON。按「污染程度」从轻到重依次尝试：
 *   1. 原样解析
 *   2. 去掉 ```json 围栏
 *   3. 截取第一个 `{` 到最后一个 `}`（模型在前面写了「好的，以下是…」的情况）
 *
 * 最后一种会掩盖「模型输出了两个 JSON」这类问题，所以它放在最后，
 * 且上面两步失败才用——顺序反了会把合法输出切坏。
 */
export function extractJson(raw: string): JsonResult {
  const cleaned = raw.replace(INVISIBLE, '').trim();
  if (!cleaned) return { ok: false, error: '模型返回了空内容' };

  const direct = tryParse(cleaned);
  if (direct.ok) return direct;

  const fenced = FENCE.exec(cleaned);
  if (fenced?.[1]) {
    const r = tryParse(fenced[1].trim());
    if (r.ok) return r;
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const r = tryParse(cleaned.slice(start, end + 1));
    if (r.ok) return r;
  }

  return { ok: false, error: `输出里找不到合法 JSON（${direct.error}）` };
}

/* ------------------------------------------------------------------ *
 * 结构化调用
 * ------------------------------------------------------------------ */

export type CompleteJsonResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: string; attempts: number; lastRaw: string };

export type CompleteJsonOptions = {
  /** 失败后的额外尝试次数，默认 1（即最多调用 2 次） */
  retries?: number;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** 回灌错误时，最多把多长的原始输出带回对话（防止上下文被撑爆） */
  echoLimit?: number;
};

/** 把 zod 的问题列表压成一行，便于回灌给模型 */
function issuesToText(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(根)'}: ${i.message}`)
    .join('；');
}

/**
 * 让模型产出符合 schema 的结构化输出。
 *
 * 重试不是「再问一遍」——那样模型大概率犯同样的错。这里把**具体的校验错误**
 * 作为新一轮的 user 消息回灌，模型才有机会定点修正。
 */
export async function completeJson<T>(
  provider: LlmProvider,
  schema: ZodType<T>,
  req: { system: string; user: string },
  opts: CompleteJsonOptions = {}
): Promise<CompleteJsonResult<T>> {
  const retries = opts.retries ?? 1;
  const echoLimit = opts.echoLimit ?? 2000;
  const messages: ChatMessage[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];

  let attempts = 0;
  let lastRaw = '';
  let lastError = '';

  for (let i = 0; i <= retries; i++) {
    attempts++;
    let raw: string;
    try {
      raw = await provider.complete({
        messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
      });
    } catch (e) {
      lastError = `调用模型失败：${(e as Error).message}`;
      // 网络/鉴权类错误重试通常也没用，直接返回，省一次无谓等待
      return { ok: false, error: lastError, attempts, lastRaw: '' };
    }
    lastRaw = raw;

    const extracted = extractJson(raw);
    if (!extracted.ok) {
      lastError = extracted.error;
    } else {
      const parsed = schema.safeParse(extracted.value);
      if (parsed.success) return { ok: true, value: parsed.data, attempts };
      lastError = `字段校验未通过：${issuesToText(parsed.error.issues)}`;
    }

    if (i < retries) {
      messages.push({ role: 'assistant', content: raw.slice(0, echoLimit) });
      messages.push({
        role: 'user',
        content:
          `你上一次的输出有问题：${lastError}\n\n` +
          `请重新输出**完整**的 JSON 对象，不要用 markdown 围栏，不要添加任何解释文字。` +
          `只输出 JSON 本身。`,
      });
    }
  }

  return { ok: false, error: lastError, attempts, lastRaw };
}
