// 第 80 轮：Vault 文件操作测试（纯目录节点的改名/删除 + 配对 md 联动 + 前缀清索引）。
// 临时目录建世界，零外依赖（WorldIndex 的 SQLite 是进程内缓存，随目录删除即弃）。
// 注意：v.index() 会起 chokidar watcher（占住事件循环）→ 每个用例 finally 里 v.close()。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../lib/vault.js';

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'soliterra-vault-'));
  const v = new Vault(root);
  const w = join(root, '测试世界');
  // 纯目录书：黄金时代/（无同名 md）；配对书：银湾.md + 银湾/
  mkdirSync(join(w, '黄金时代'), { recursive: true });
  writeFileSync(join(w, '黄金时代', '北伐.md'), '&s 0662.08.17\n\n# 北伐\n', 'utf8');
  writeFileSync(join(w, '银湾.md'), '&n 银湾\n\n# 银湾\n', 'utf8');
  mkdirSync(join(w, '银湾'), { recursive: true });
  writeFileSync(join(w, '银湾', '附记.md'), '# 附记\n', 'utf8');
  return { root, v, w };
};

const withWorld = async (fn) => {
  const { root, v, w } = mk();
  try { await fn(v, w); }
  finally { v.close('测试世界'); rmSync(root, { recursive: true, force: true }); }
};

test('renameEntry：纯目录节点改名（子文件保留、配对 md 若有则联动、&n 同步）', () => withWorld((v, w) => {
  // ① 纯目录：黄金时代 → 白银时代
  const r1 = v.renameEntry('测试世界', '黄金时代', '白银时代');
  assert.equal(r1.path, '白银时代');
  assert.ok(existsSync(join(w, '白银时代', '北伐.md')), '子文件随目录改名');
  assert.ok(!existsSync(join(w, '黄金时代')), '旧目录不残留');
  // ② 配对书：银湾（传目录路径）→ 银湾港：目录 + 同名 md 一并改名，md 内 &n 同步
  const r2 = v.renameEntry('测试世界', '银湾', '银湾港');
  assert.equal(r2.path, '银湾港');
  assert.ok(existsSync(join(w, '银湾港', '附记.md')));
  assert.ok(existsSync(join(w, '银湾港.md')), '配对 md 联动改名');
  assert.match(readFileSync(join(w, '银湾港.md'), 'utf8'), /^&n 银湾港$/m, '&n 同步新名');
  assert.ok(!existsSync(join(w, '银湾.md')) && !existsSync(join(w, '银湾')));
  // ③ 索引可见新路径
  const idx = v.index('测试世界');
  assert.ok(idx.entry('白银时代/北伐.md'), '子树已重建索引');
  assert.ok(idx.entry('银湾港/附记.md') && idx.entry('银湾港.md'), '配对书两侧都在索引');
}));

test('deleteEntry：纯目录节点整书入回收站（+ 配对 md 联动）', () => withWorld((v, w) => {
  const res = v.deleteEntry('测试世界', '黄金时代');
  assert.match(res.trashed, /^\.soliterra\/trash-.*\/黄金时代$/);
  assert.ok(!existsSync(join(w, '黄金时代')), '目录已移走');
  const trashRoot = join(w, '.soliterra');
  const trashDirs = readdirSync(trashRoot).filter((n) => n.startsWith('trash-'));
  assert.equal(trashDirs.length, 1);
  assert.ok(existsSync(join(trashRoot, trashDirs[0], '黄金时代', '北伐.md')), '内容整体在回收站');
  // 配对书删除：目录 + 同名 md 都进回收站
  const res2 = v.deleteEntry('测试世界', '银湾');
  assert.match(res2.trashed, /^\.soliterra\/trash-.*\/银湾$/);
  assert.ok(!existsSync(join(w, '银湾')) && !existsSync(join(w, '银湾.md')), '目录与配对 md 都移走');
  const trash2 = readdirSync(trashRoot).filter((n) => n.startsWith('trash-'));
  assert.ok(trash2.some((t2) => existsSync(join(trashRoot, t2, '银湾.md'))), '配对 md 在回收站');
}));

test('removePrefix：按目录前缀清索引（外部整目录删除的 watcher 路径）', () => withWorld((v) => {
  const idx = v.index('测试世界');
  assert.ok(idx.entry('黄金时代/北伐.md'), '索引先有条目');
  idx.removePrefix('黄金时代');
  assert.ok(!idx.entry('黄金时代/北伐.md'), '前缀内条目移除');
  assert.ok(idx.entry('银湾/附记.md'), '前缀外条目不受影响');
}));

test('renameEntry 仍支持 md 路径（原行为不回退）', () => withWorld((v, w) => {
  const r = v.renameEntry('测试世界', '银湾.md', '银湾湾');
  assert.equal(r.path, '银湾湾.md');
  assert.ok(existsSync(join(w, '银湾湾.md')) && existsSync(join(w, '银湾湾', '附记.md')));
}));
