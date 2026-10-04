import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { completeJson, extractJson } from './provider.ts';
import type { ChatMessage, LlmProvider } from './provider.ts';

/** 按脚本依次返回预设结果的 provider；记录每次收到的 messages 便于断言 */
function scripted(responses: (string | Error)[]): LlmProvider & { calls: ChatMessage[][] } {
  let i = 0;
  const calls: ChatMessage[][] = [];
  return {
    name: 'scripted',
    calls,
    async complete(req) {
      calls.push(req.messages.map((m) => ({ ...m })));
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('extractJson', () => {
  it('干净的 JSON 直接通过', () => {
    const r = extractJson('{"a":1}');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { a: 1 });
  });

  it('剥掉 ```json 围栏', () => {
    const r = extractJson('```json\n{"a":1}\n```');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { a: 1 });
  });

  it('剥掉无语言标注的围栏', () => {
    const r = extractJson('```\n{"a":1}\n```');
    assert.equal(r.ok, true);
  });

  it('忽略模型前面写的客套话', () => {
    const r = extractJson('好的，以下是结果：\n{"a":1}\n希望有帮助。');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { a: 1 });
  });

  it('清掉 BOM 与零宽字符（肉眼看不见但会让 JSON.parse 失败）', () => {
    const r = extractJson('\uFEFF{"a"\u200B:1}');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { a: 1 });
  });

  it('空内容给出明确错误', () => {
    const r = extractJson('   ');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /空内容/);
  });

  it('完全不是 JSON 时失败，而不是瞎猜', () => {
    const r = extractJson('我觉得这个计划挺好的。');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /找不到合法 JSON/);
  });

  it('两个并列的 JSON 对象会失败——宁可报错也不猜哪个才对', () => {
    const r = extractJson('{"a":1} {"b":2}');
    assert.equal(r.ok, false);
  });

  it('嵌套花括号也能正确截取', () => {
    const r = extractJson('前言 {"a":{"b":[1,2]}} 后记');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, { a: { b: [1, 2] } });
  });
});

describe('completeJson', () => {
  const Schema = z.object({ name: z.string(), score: z.number().min(0).max(1) });

  it('一次成功', async () => {
    const p = scripted(['{"name":"小明","score":0.5}']);
    const r = await completeJson(p, Schema, { system: 's', user: 'u' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value, { name: '小明', score: 0.5 });
      assert.equal(r.attempts, 1);
    }
    assert.equal(p.calls.length, 1);
  });

  it('schema 的 default 被应用', async () => {
    const S = z.object({ a: z.number(), b: z.string().default('默认') });
    const p = scripted(['{"a":1}']);
    const r = await completeJson(p, S, { system: 's', user: 'u' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.b, '默认');
  });

  it('校验失败后把【具体错误】回灌重试，而不是原样再问一遍', async () => {
    const p = scripted(['{"name":"小明","score":5}', '{"name":"小明","score":0.5}']);
    const r = await completeJson(p, Schema, { system: 's', user: 'u' });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);

    const retry = p.calls[1]!;
    assert.equal(retry.length, 4, '重试时应带上 system + user + 上次输出 + 纠错指令');
    assert.equal(retry[2]!.role, 'assistant');
    assert.equal(retry[3]!.role, 'user');
    assert.match(retry[2]!.content, /score/, '应把上一次的原始输出带回去');
    assert.match(retry[3]!.content, /score/, '纠错指令里应包含出错的字段路径');
    assert.match(retry[3]!.content, /只输出 JSON/);
  });

  it('JSON 提取失败也走同一条重试路径', async () => {
    const p = scripted(['抱歉我无法完成', '{"name":"小明","score":0.5}']);
    const r = await completeJson(p, Schema, { system: 's', user: 'u' });
    assert.equal(r.ok, true);
    assert.match(p.calls[1]![3]!.content, /找不到合法 JSON/);
  });

  it('重试次数用尽后返回失败，并带上最后一次原始输出', async () => {
    const p = scripted(['{"name":"小明","score":9}']);
    const r = await completeJson(p, Schema, { system: 's', user: 'u' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.attempts, 2);
      assert.equal(r.lastRaw, '{"name":"小明","score":9}');
      assert.match(r.error, /字段校验未通过/);
    }
  });

  it('retries:0 时只调用一次', async () => {
    const p = scripted(['不是 JSON']);
    const r = await completeJson(p, Schema, { system: 's', user: 'u' }, { retries: 0 });
    assert.equal(r.ok, false);
    assert.equal(p.calls.length, 1);
  });

  it('网络/鉴权类错误不重试——重试也只是白等', async () => {
    const p = scripted([new Error('HTTP 401：invalid api key')]);
    const r = await completeJson(p, Schema, { system: 's', user: 'u' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /调用模型失败.*401/);
    assert.equal(p.calls.length, 1, '不该重试');
  });

  it('回灌的原始输出会被截断，避免上下文被撑爆', async () => {
    const huge = `{"name":"${'x'.repeat(5000)}","score":9}`;
    const p = scripted([huge, '{"name":"小明","score":0.5}']);
    await completeJson(p, Schema, { system: 's', user: 'u' }, { echoLimit: 100 });
    const echoed = p.calls[1]![2]!.content;
    assert.ok(echoed.length <= 100, `回灌内容被截断到 100，实际 ${echoed.length}`);
  });
});
