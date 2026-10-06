// 第 78 轮：工具库测试（备份剪枝 + apply 端到端）。临时目录操作，零外依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, pruneBackups } from '../lib/tools.js';

const mkWorld = () => mkdtempSync(join(tmpdir(), 'soliterra-test-'));
const fakeBackup = (dir, i) => {
  const name = `backup-2026-01-01T00-${String(i).padStart(2, '0')}-00-000Z`;   // 字典序 = 时间序
  mkdirSync(join(dir, '.soliterra', name), { recursive: true });
  writeFileSync(join(dir, '.soliterra', name, 'x.md'), `old ${i}`, 'utf8');
  return name;
};

test('pruneBackups：只保留最近 keep 份，删最旧（按 ISO 时间戳名字典序）', () => {
  const dir = mkWorld();
  for (let i = 0; i < 13; i++) fakeBackup(dir, i);
  const removed = pruneBackups(dir, 10);
  assert.equal(removed, 3);
  const left = readdirSync(join(dir, '.soliterra')).filter((n) => n.startsWith('backup-')).sort();
  assert.equal(left.length, 10);
  assert.ok(!left.includes('backup-2026-01-01T00-00-00-000Z'), '最旧的应被删');
  assert.ok(left.includes('backup-2026-01-01T00-12-00-000Z'), '最新的应保留');
  assert.equal(pruneBackups(dir, 10), 0, '已达标 → 不再删');
  // 未达上限时不删
  const dir2 = mkWorld();
  for (let i = 0; i < 4; i++) fakeBackup(dir2, i);
  assert.equal(pruneBackups(dir2, 10), 0);
  assert.equal(readdirSync(join(dir2, '.soliterra')).filter((n) => n.startsWith('backup-')).length, 4);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test('apply：改文件（行内容匹配）+ 写前备份 + 超限自动剪枝', () => {
  const dir = mkWorld();
  writeFileSync(join(dir, 'a.md'), '&s 705.9.10\n\n# 甲\n', 'utf8');
  for (let i = 0; i < 12; i++) fakeBackup(dir, i);   // 预置 12 份旧备份
  const res = apply(dir, 'normalize', [{ path: 'a.md', before: '&s 705.9.10', after: '&s 0705.09.10' }]);
  assert.equal(res.changed, 1);
  assert.match(readFileSync(join(dir, 'a.md'), 'utf8'), /&s 0705\.09\.10/, '目标行已替换');
  assert.match(res.backup, /^\.soliterra\/backup-/, '返回备份相对路径');
  const backups = readdirSync(join(dir, '.soliterra')).filter((n) => n.startsWith('backup-')).sort();
  assert.equal(backups.length, 10, '12 旧 + 1 新 = 13 → 剪到 10');
  // 本次备份内容 = 改前原文（可用于回滚）
  const newest = backups[backups.length - 1];
  assert.equal(readFileSync(join(dir, '.soliterra', newest, 'a.md'), 'utf8'), '&s 705.9.10\n\n# 甲\n');
  rmSync(dir, { recursive: true, force: true });
});

test('apply：删除行（after 为空）与行号漂移（同内容多处按计数替换）', () => {
  const dir = mkWorld();
  writeFileSync(join(dir, 'b.md'), '&x 1\n&x 1\nkeep\n', 'utf8');
  const res = apply(dir, 'dup', [
    { path: 'b.md', before: '&x 1', after: '&x 1' },        // 第一处：原地替换（同值）
    { path: 'b.md', before: '&x 1', after: '' },            // 第二处：删除行
  ]);
  assert.equal(res.changed, 2);
  const out = readFileSync(join(dir, 'b.md'), 'utf8');
  assert.equal(out, '&x 1\nkeep\n');
  assert.ok(existsSync(join(dir, '.soliterra')));
  rmSync(dir, { recursive: true, force: true });
});
