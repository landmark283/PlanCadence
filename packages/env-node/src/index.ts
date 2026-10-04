/**
 * `.env` 加载器。
 *
 * 为什么不用 Node 自带的 `--env-file`：那个选项相对 **cwd** 解析路径，
 * 而本仓库的脚本会从不同目录启动（`pnpm plan` 在根目录、
 * `pnpm --filter @sp/server start` 在 apps/server、测试指南里又可能直接
 * 从根目录 `node apps/server/src/index.ts`）。写死相对路径必然有一处是错的。
 * 这里改成**从起始目录向上查找**，三种姿势都能找到同一个根目录的 `.env`。
 *
 * 与 Node 原生 `--env-file` 的语义差异：**真实环境变量优先**。
 * CI 里注入的密钥不该被仓库里的一份文件悄悄覆盖掉。
 */
import fs from 'node:fs';
import path from 'node:path';

export type LoadEnvResult = {
  /** 实际加载的文件；没找到为 null */
  path: string | null;
  /** 本次新注入的键名 */
  injected: string[];
  /** 文件中存在、但被真实环境变量压住的键名 */
  skipped: string[];
};

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 dotenv 风格文本。
 *
 * 支持：注释、空行、`export KEY=` 前缀、单/双引号包裹、双引号内的 `\n` `\t` `\\` `\"`、
 * 未加引号时的 ` #` 行尾注释、CRLF、BOM。
 * 不支持多行值——我们的配置里没有这种需求，支持它反而引入歧义。
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    const quote = value[0];

    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        // 单遍扫描，避免 `\\n` 这种转义被二次处理
        value = value.replace(/\\(.)/g, (_, c: string) =>
          c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
        );
      }
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/** 从 startDir 向上找 filename，找不到返回 null */
export function findEnvFile(startDir: string = process.cwd(), filename = '.env', maxDepth = 8): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, filename);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在或没权限，继续往上找
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到根了
    dir = parent;
  }
  return null;
}

export type LoadEnvOptions = {
  startDir?: string;
  filename?: string;
  /** true 时 .env 覆盖真实环境变量。默认 false——真实环境优先 */
  override?: boolean;
  /** 便于测试注入，默认 process.env */
  env?: NodeJS.ProcessEnv;
};

export function loadEnvFile(opts: LoadEnvOptions = {}): LoadEnvResult {
  const env = opts.env ?? process.env;
  const file = findEnvFile(opts.startDir ?? process.cwd(), opts.filename ?? '.env');
  if (!file) return { path: null, injected: [], skipped: [] };

  const injected: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
    // 空字符串等同于未设置——与 config.ts 对「未配置」的判定保持一致，
    // 否则 `LLM_API_KEY=` 这种占位会让人以为配了。
    const exists = env[key] !== undefined && env[key] !== '';
    if (exists && !opts.override) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    injected.push(key);
  }

  return { path: file, injected, skipped };
}
