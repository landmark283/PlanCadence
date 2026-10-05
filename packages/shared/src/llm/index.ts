/**
 * LLM 相关中**留在共享层**的部分：契约、提示词、输出校验、降级视图。
 *
 * 这些都不碰网络，因此可以留在 `packages/shared` —— 移动端要能在断网时
 * 用 `engineView` 在本机把复盘算出来，这是产品在弱网下仍然可用的关键。
 *
 * HTTP 客户端（provider 契约、completeJson、OpenAI 兼容适配器）在 `@sp/llm-client`，
 * 那边需要 fetch 等全局，不适合放进维持「Hermes 可跑」护栏的 shared。
 */
export * from './advisor.ts';
export * from './interview.ts';
export * from './planner.ts';
export * from './settle-narrative.ts';
export * from './talk.ts';
