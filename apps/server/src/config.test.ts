import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeLlm, loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('完全没配 LLM 时可用——这条路就是降级模式', () => {
    const r = loadConfig({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.llm, null);
      assert.equal(r.config.port, 8787);
    }
  });

  it('三个变量齐全时装配出 LLM 配置', () => {
    const r = loadConfig({
      LLM_BASE_URL: 'https://api.deepseek.com/v1',
      LLM_API_KEY: 'sk-x',
      LLM_MODEL: 'deepseek-chat',
      LLM_JSON_MODE: '1',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.config.llm, {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-x',
        model: 'deepseek-chat',
        jsonMode: true,
      });
    }
  });

  it('只配了一半就报错——否则服务能起来但每个请求都悄悄降级', () => {
    const r = loadConfig({ LLM_BASE_URL: 'https://x/v1', LLM_MODEL: 'm' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /不完整/);
      assert.match(r.error, /LLM_API_KEY/);
    }
  });

  it('空字符串等同于未配置', () => {
    const r = loadConfig({ LLM_BASE_URL: '  ', LLM_API_KEY: '', LLM_MODEL: 'm' });
    assert.equal(r.ok, false);
  });

  it('非法端口被拒绝', () => {
    for (const bad of ['abc', '0', '-1', '70000', '1.5']) {
      const r = loadConfig({ PORT: bad });
      assert.equal(r.ok, false, `应拒绝 PORT=${bad}`);
    }
  });

  it('HOST 可覆盖', () => {
    const r = loadConfig({ HOST: '127.0.0.1', PORT: '9000' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.host, '127.0.0.1');
      assert.equal(r.config.port, 9000);
    }
  });
});

describe('describeLlm：绝不能把密钥带出来', () => {
  it('未配置时只报 configured:false', () => {
    assert.deepEqual(describeLlm(null), { configured: false });
  });

  it('已配置时给模型与地址，但【不含】apiKey 字段', () => {
    const d = describeLlm({ baseUrl: 'https://x/v1', apiKey: 'sk-secret', model: 'm', jsonMode: false });
    assert.equal(d.configured, true);
    assert.equal(d.model, 'm');
    assert.ok(!JSON.stringify(d).includes('sk-secret'), '响应里不能出现密钥');
    assert.ok(!('apiKey' in d));
  });
});
