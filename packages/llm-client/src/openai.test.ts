import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiCompatProvider } from './openai.ts';

type Captured = { url: string; init: RequestInit };

/** 假 fetch：记录请求，返回预设响应 */
function fakeFetch(response: { status?: number; body: string }, captured: Captured[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init! });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
}

const okBody = (content: string) =>
  JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });

describe('createOpenAiCompatProvider', () => {
  it('拼出正确的 URL 与鉴权头', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetchImpl: fakeFetch({ body: okBody('你好') }, cap),
    });
    const out = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(out, '你好');
    assert.equal(cap[0]!.url, 'https://api.deepseek.com/v1/chat/completions');
    const headers = cap[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.equal(headers['content-type'], 'application/json');
  });

  it('baseUrl 结尾有斜杠也不会拼出双斜杠', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://x.example/v1///',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({ body: okBody('x') }, cap),
    });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(cap[0]!.url, 'https://x.example/v1/chat/completions');
  });

  it('只发送有值的可选参数——显式传 null 会被部分兼容端点拒绝', async () => {
    const cap: Captured[] = [];
    const make = () =>
      createOpenAiCompatProvider({
        baseUrl: 'https://x.example/v1',
        apiKey: 'k',
        model: 'm',
        fetchImpl: fakeFetch({ body: okBody('x') }, cap),
      });

    await make().complete({ messages: [{ role: 'user', content: 'hi' }] });
    let body = JSON.parse(cap[0]!.init.body as string);
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
    assert.ok(!('temperature' in body) && !('max_tokens' in body) && !('response_format' in body));

    await make().complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 100 });
    body = JSON.parse(cap[1]!.init.body as string);
    assert.equal(body.temperature, 0, 'temperature=0 是合法值，不能被当成「未设置」丢掉');
    assert.equal(body.max_tokens, 100);
  });

  it('默认不发 response_format（各家支持程度不一）', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({ body: okBody('x') }, cap),
    });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!('response_format' in JSON.parse(cap[0]!.init.body as string)));
  });

  it('jsonMode 打开时才发 response_format', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      jsonMode: true,
      fetchImpl: fakeFetch({ body: okBody('x') }, cap),
    });
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(JSON.parse(cap[0]!.init.body as string).response_format, { type: 'json_object' });
  });

  it('非 2xx 抛出带状态码与响应体片段的错误', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({ status: 401, body: '{"error":{"message":"invalid api key"}}' }, cap),
    });
    await assert.rejects(() => p.complete({ messages: [{ role: 'user', content: 'hi' }] }), /HTTP 401.*invalid api key/s);
  });

  it('content 为空时带出 finish_reason，便于定位是被截断还是被拦截', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({ body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) }, cap),
    });
    await assert.rejects(() => p.complete({ messages: [{ role: 'user', content: 'hi' }] }), /空内容.*length/s);
  });

  it('响应不是 JSON 时给出可读错误', async () => {
    const cap: Captured[] = [];
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://x.example/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({ body: '<html>502 Bad Gateway</html>' }, cap),
    });
    await assert.rejects(() => p.complete({ messages: [{ role: 'user', content: 'hi' }] }), /不是合法 JSON/);
  });

  it('网络错误会带上 baseUrl，方便判断是配置错还是断网', async () => {
    const p = createOpenAiCompatProvider({
      baseUrl: 'https://wrong.example/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    });
    await assert.rejects(() => p.complete({ messages: [{ role: 'user', content: 'hi' }] }), /无法连接到 https:\/\/wrong\.example\/v1/);
  });

  it('provider.name 带上模型名，便于日志区分', () => {
    const p = createOpenAiCompatProvider({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'qwen-plus' });
    assert.equal(p.name, 'openai-compat:qwen-plus');
  });
});
