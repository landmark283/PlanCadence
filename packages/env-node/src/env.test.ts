import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEnvFile, loadEnvFile, parseEnv } from './index.ts';

describe('parseEnv', () => {
  it('基本键值对', () => {
    assert.deepEqual(parseEnv('A=1\nB=two'), { A: '1', B: 'two' });
  });

  it('忽略注释与空行', () => {
    assert.deepEqual(parseEnv('# 注释\n\nA=1\n   \n# 另一条'), { A: '1' });
  });

  it('支持 export 前缀', () => {
    assert.deepEqual(parseEnv('export A=1'), { A: '1' });
  });

  it('去掉成对引号', () => {
    assert.deepEqual(parseEnv(`A="x y"\nB='p q'`), { A: 'x y', B: 'p q' });
  });

  it('保留未加引号值里的空格', () => {
    assert.deepEqual(parseEnv('A=hello world'), { A: 'hello world' });
  });

  it('未加引号时的行尾注释被裁掉', () => {
    assert.deepEqual(parseEnv('A=1 # 说明'), { A: '1' });
  });

  it('加引号时 # 是值的一部分，不当作注释', () => {
    assert.deepEqual(parseEnv('A="a # b"'), { A: 'a # b' });
  });

  it('双引号内解析 \\n \\t 与转义反斜杠', () => {
    assert.deepEqual(parseEnv('A="x\\ny"'), { A: 'x\ny' });
    assert.deepEqual(parseEnv('A="x\\\\y"'), { A: 'x\\y' });
  });

  it('单引号内不做转义处理', () => {
    assert.deepEqual(parseEnv("A='x\\ny'"), { A: 'x\\ny' });
  });

  it('`\\\\n` 这类连续转义不会被二次处理', () => {
    // 期望：反斜杠 + 字母 n，而不是反斜杠 + 换行
    assert.deepEqual(parseEnv('A="\\\\n"'), { A: '\\n' });
  });

  it('处理 BOM 与 CRLF', () => {
    assert.deepEqual(parseEnv('\uFEFFA=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });

  it('值是空串也保留该键', () => {
    assert.deepEqual(parseEnv('A='), { A: '' });
  });

  it('跳过非法行（没有 =、键名不合法）', () => {
    assert.deepEqual(parseEnv('JUSTTEXT\n1BAD=x\nA=1\n=x'), { A: '1' });
  });

  it('值里含 = 时从第一个 = 切分', () => {
    assert.deepEqual(parseEnv('A=a=b=c'), { A: 'a=b=c' });
  });
});

describe('findEnvFile', () => {
  let root = '';
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-env-'));
    fs.mkdirSync(path.join(root, 'apps', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'A=1', 'utf8');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('在起始目录找到', () => {
    assert.equal(findEnvFile(root), path.join(root, '.env'));
  });

  it('从子目录向上找到', () => {
    assert.equal(findEnvFile(path.join(root, 'apps', 'server')), path.join(root, '.env'));
  });

  it('从深层子目录也能找到', () => {
    const deep = path.join(root, 'apps', 'server', 'src', 'routes');
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(findEnvFile(deep), path.join(root, '.env'));
  });

  it('找不到时返回 null，而不是抛异常', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-empty-'));
    assert.equal(findEnvFile(empty, '.env', 2), null);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('可以找自定义文件名', () => {
    fs.writeFileSync(path.join(root, '.env.test'), 'B=2', 'utf8');
    assert.equal(findEnvFile(root, '.env.test'), path.join(root, '.env.test'));
  });
});

describe('loadEnvFile', () => {
  let root = '';
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-env2-'));
    fs.writeFileSync(path.join(root, '.env'), 'LLM_MODEL=m\nLLM_API_KEY=from-file\nEMPTY=\n', 'utf8');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('注入文件里的键，并返回加载路径', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadEnvFile({ startDir: root, env });
    assert.equal(r.path, path.join(root, '.env'));
    assert.equal(env.LLM_MODEL, 'm');
    assert.deepEqual(r.injected.sort(), ['EMPTY', 'LLM_API_KEY', 'LLM_MODEL']);
  });

  it('真实环境变量优先——CI 注入的密钥不该被仓库文件覆盖', () => {
    const env: NodeJS.ProcessEnv = { LLM_API_KEY: 'from-ci' };
    const r = loadEnvFile({ startDir: root, env });
    assert.equal(env.LLM_API_KEY, 'from-ci');
    assert.deepEqual(r.skipped, ['LLM_API_KEY']);
    assert.equal(env.LLM_MODEL, 'm', '未设置过的键仍应注入');
  });

  it('override:true 时反过来覆盖', () => {
    const env: NodeJS.ProcessEnv = { LLM_API_KEY: 'from-ci' };
    loadEnvFile({ startDir: root, env, override: true });
    assert.equal(env.LLM_API_KEY, 'from-file');
  });

  it('真实环境变量为空串时视为未设置', () => {
    const env: NodeJS.ProcessEnv = { LLM_API_KEY: '' };
    loadEnvFile({ startDir: root, env });
    assert.equal(env.LLM_API_KEY, 'from-file');
  });

  it('没有 .env 时安静返回，不抛错', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-none-'));
    const env: NodeJS.ProcessEnv = {};
    const r = loadEnvFile({ startDir: empty, env });
    assert.equal(r.path, null);
    assert.deepEqual(env, {});
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
