/**
 * LLM 客户端：provider 契约 + JSON 提取 + 结构化调用 + OpenAI 兼容适配器。
 *
 * 为什么单独成包而不放在 packages/shared：
 *   shared 要保持「无 DOM 类型、无 Node 类型」的护栏，以保证它的逻辑真能在 Hermes 上跑。
 *   而这一层需要 fetch / Response / AbortController / setTimeout。
 *
 * 注意移动端**不**使用这个包——App 通过服务端代理调用模型，不直连。
 * 但移动端会用 `@sp/shared` 里的 `engineView`：断网时在本机把复盘算出来并降级展示，
 * 那是这个产品在弱网下仍然可用的关键。
 */
export * from './provider.ts';
export * from './openai.ts';
