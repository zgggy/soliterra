// 第 105 轮：搜索 trigram 升级（P1）——中文子串 MATCH / 两字词 LIKE / 旧表直接重建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldIndex } from '../lib/indexer.js';

const withIndex = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'soliterra-idx-'));
  const world = join(dir, '世界');
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, 'a.md'), '&n 洛桑学派\n\n洛桑学派主导了北伐，三力通论是其根基。\n', 'utf8');
  writeFileSync(join(world, 'b.md'), '&n 西都\n\n西都城防与后勤体系。\n', 'utf8');
  const idx = new WorldIndex(world);
  try { idx.rebuild(); fn(idx); }
  finally { idx.close(); rmSync(dir, { recursive: true, force: true }); }
};

test('search：≥3 字 MATCH（rank+snippet）；两字词 trigram 表 LIKE 命中', () => withIndex((idx) => {
  const r1 = idx.search('洛桑学派');
  assert.equal(r1.length, 1, '四字词 MATCH 命中');
  assert.ok(r1[0].snip.includes('<mark>洛桑学派</mark>'), 'snippet 高亮');
  const r2 = idx.search('北伐');
  assert.equal(r2.length, 1, '两字词 LIKE 通道命中');
  assert.ok(r2[0].snip.includes('<mark>北伐</mark>'), '两字词也带高亮');
  const r3 = idx.search('不存在的词');
  assert.equal(r3.length, 0);
}));

test('search：通配符转义（%_ 当字面搜）与空词返回空', () => withIndex((idx) => {
  writeFileSync(join(idx.worldDir, 'c.md'), '含有百分号 100% 的文本\n', 'utf8');
  idx.indexFile('c.md');
  assert.equal(idx.search('100%').length, 1, '% 转义后按字面命中');
  assert.equal(idx.search('_').length, 0, '_ 不当单字符通配');
  assert.deepEqual(idx.search(''), []);
}));

test('旧 fts 表（unicode61）启动直接重建为 trigram（旧库不管，从 entries 重灌）', () => withIndex((idx) => {
  // 手动把表换回旧版再开新实例（模拟旧库）
  idx.db.exec('DROP TABLE fts');
  idx.db.exec('CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, body)');
  idx.db.prepare('INSERT INTO fts (path,title,body) VALUES (?,?,?)').run('a.md', '旧表数据', '北伐旧内容');
  idx.close();
  const idx2 = new WorldIndex(idx.worldDir);   // 构造时应检测非 trigram → 重建
  try {
    const sql = idx2.db.prepare(`SELECT sql FROM sqlite_master WHERE name='fts'`).get().sql;
    assert.ok(/trigram/.test(sql), '已重建为 trigram');
    const r = idx2.search('北伐');
    assert.equal(r.length, 1, '重建后从 entries 重灌的数据可搜');
    assert.equal(r[0].path, 'a.md');
  } finally { idx2.close(); }
}));
