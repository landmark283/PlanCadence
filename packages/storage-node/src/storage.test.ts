import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planPath, snapshotPath } from '@sp/shared';
import { nodeFsStorage } from './index.ts';

let root = '';
let storage: ReturnType<typeof nodeFsStorage>;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-storage-'));
  storage = nodeFsStorage(root);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('计划文件读写', () => {
  it('写出后能读回（含中文与换行）', async () => {
    const text = '# 计划\nschema: studyplan/v1\n目标: 拿下蓝桥杯\n';
    await storage.writePlan('plan_a', text);
    assert.equal(await storage.readPlan('plan_a'), text);
  });

  it('读不存在的计划返回 null，而不是抛异常', async () => {
    assert.equal(await storage.readPlan('plan_missing'), null);
  });

  it('重复写入会覆盖，且不残留临时文件', async () => {
    await storage.writePlan('plan_b', 'first');
    await storage.writePlan('plan_b', 'second');
    assert.equal(await storage.readPlan('plan_b'), 'second');

    const dir = path.join(root, 'plan_b');
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '原子写入不应留下临时文件');
  });

  it('自动创建多层目录', async () => {
    await storage.writePlan('plan_c', 'x');
    assert.ok((await fs.stat(path.join(root, planPath('plan_c')))).isFile());
  });
});

describe('版本快照', () => {
  it('初始没有快照', async () => {
    assert.deepEqual(await storage.listSnapshots('plan_snap'), []);
  });

  it('写入后按版本号升序返回（而不是按字典序）', async () => {
    for (const v of [10, 2, 33, 1]) await storage.writeSnapshot('plan_snap', v, `v${v}`);
    assert.deepEqual(await storage.listSnapshots('plan_snap'), [1, 2, 10, 33]);
  });

  it('能读回指定版本，缺失版本返回 null', async () => {
    assert.equal(await storage.readSnapshot('plan_snap', 10), 'v10');
    assert.equal(await storage.readSnapshot('plan_snap', 7), null);
  });

  it('快照与当前计划互不干扰', async () => {
    await storage.writePlan('plan_snap', 'current');
    assert.equal(await storage.readPlan('plan_snap'), 'current');
    assert.equal(await storage.readSnapshot('plan_snap', 2), 'v2');
  });

  it('目录里的无关文件不会被当成快照', async () => {
    const dir = path.join(root, 'plan_snap', 'versions');
    await fs.writeFile(path.join(dir, 'README.md'), 'ignore me', 'utf8');
    await fs.writeFile(path.join(dir, 'v4.studyplan.bak'), 'ignore me too', 'utf8');
    assert.deepEqual(await storage.listSnapshots('plan_snap'), [1, 2, 10, 33]);
  });
});

describe('路径安全', () => {
  it('拒绝会导致目录穿越的 id', async () => {
    for (const bad of ['../../etc/passwd', 'a/b', 'Plan_A', '1abc', '', 'a'.repeat(40)]) {
      await assert.rejects(() => storage.writePlan(bad, 'x'), /非法的计划 id/, `应拒绝 ${JSON.stringify(bad)}`);
    }
  });

  it('拒绝非法版本号', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(() => storage.writeSnapshot('plan_snap', bad, 'x'), /非法的版本号/);
    }
  });

  it('恶意 id 不会真的写出任何文件', async () => {
    const before = await fs.readdir(root);
    await assert.rejects(() => storage.writePlan('../escape', 'x'));
    assert.deepEqual(await fs.readdir(root), before);
  });
});
