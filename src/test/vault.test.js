// 第 80 轮：Vault 文件操作测试（纯目录节点的改名/删除 + 配对 md 联动 + 前缀清索引）。
// 临时目录建世界，零外依赖（WorldIndex 的 SQLite 是进程内缓存，随目录删除即弃）。
// 注意：v.index() 会起 chokidar watcher（占住事件循环）→ 每个用例 finally 里 v.close()。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
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

test('worldInfo/list 带 dir：世界真实存储位置（第 87 轮）', () => withWorld((v, w) => {
  const info = v.worldInfo('测试世界');
  assert.equal(info.dir, realpathSync(w), 'worldInfo.dir = 世界目录绝对路径');
  const li = v.list();
  assert.equal(li.find((x) => x.id === '测试世界').dir, realpathSync(w), 'list 条目带 dir');
}));

test('符号链接世界：dir 显示真实目标（库外文件夹接入）', () => {
  const root = mkdtempSync(join(tmpdir(), 'soliterra-vault-'));
  const ext = mkdtempSync(join(tmpdir(), 'soliterra-ext-'));
  const worldsDir = join(root, 'worlds');
  const v = new Vault(worldsDir);
  try {
    writeFileSync(join(ext, '外置.md'), '&n 外置\n\n# 外置\n', 'utf8');
    symlinkSync(ext, join(worldsDir, '链接世界'), 'dir');
    const li = v.list();
    const link = li.find((x) => x.id === '链接世界');
    assert.ok(link, '符号链接世界被 list 识别');
    assert.equal(link.dir, realpathSync(ext), 'dir 穿透符号链接 = 真实目标');
    assert.equal(v.realDir('链接世界'), realpathSync(ext));
  } finally {
    v.close('链接世界');
    rmSync(root, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});


// ============ 第 88 轮：采纳本地文件夹（adopt）+ README 根条目约定 ============

const mkBare = () => {
  const root = mkdtempSync(join(tmpdir(), 'soliterra-adopt-'));
  const lib = join(root, '库');
  const v = new Vault(lib);
  return { root, lib, v };
};

test('adopt：空文件夹（库外）→ README.md + assets/cover + .gitignore + git init + 链接登记', () => {
  const { root, lib, v } = mkBare();
  const folder = join(root, '我的新世界');
  const cover = join(root, 'cover.png');
  try {
    mkdirSync(folder);
    writeFileSync(cover, 'PNGDATA-1', 'utf8');
    const info = v.adoptFolder({ dir: folder, intro: '一句话介绍', coverPath: cover });
    assert.equal(info.name, '我的新世界');
    assert.equal(info.rootRel, 'README.md');
    assert.equal(info.linked, true, '库外文件夹 → 链接登记');
    assert.equal(info.dir, realpathSync(folder));
    const readme = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.ok(readme.startsWith('&n 我的新世界'), '&n 首行');
    assert.ok(readme.includes('&m assets/cover.png'));
    assert.ok(readme.includes('# 我的新世界') && readme.includes('一句话介绍'));
    assert.ok(existsSync(join(folder, 'assets', 'cover.png')), '封面复制进 assets/');
    assert.equal(readFileSync(join(folder, 'assets', 'cover.png'), 'utf8'), 'PNGDATA-1');
    assert.ok(readFileSync(join(folder, '.gitignore'), 'utf8').includes('.soliterra/'));
    assert.ok(existsSync(join(folder, '.git')), 'git init');
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: folder }).toString().trim(), 'init: 创建世界 我的新世界');
    const link = join(lib, '我的新世界');
    assert.ok(lstatSync(link).isSymbolicLink(), '库内符号链接');
    assert.equal(realpathSync(link), realpathSync(folder));
    const li = v.list();
    assert.equal(li.find((x) => x.id === '我的新世界')?.linked, true, 'list 带 linked 标记');
  } finally {
    v.close('我的新世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt：库内直接子文件夹 → 原地（无链接）', () => {
  const { root, lib, v } = mkBare();
  const folder = join(lib, '库内世界');
  try {
    mkdirSync(folder, { recursive: true });
    const info = v.adoptFolder({ dir: folder, intro: '库内的' });
    assert.equal(info.id, '库内世界');
    assert.equal(info.linked, false, '直接子文件夹不建链接');
    assert.ok(!lstatSync(folder).isSymbolicLink());
    assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').includes('库内的'));
  } finally {
    v.close('库内世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt：已有 README.md → 正文一字不动、只补 & 行、重复采纳幂等', () => {
  const { root, v } = mkBare();
  const folder = join(root, '旧稿世界');
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# 我的旧说明\n\n正文第一段。\n', 'utf8');
    writeFileSync(join(folder, '.gitignore'), 'node_modules/\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: folder });
    const info = v.adoptFolder({ dir: folder, intro: '（不应写入）', coverPath: '' });
    assert.equal(info.name, '旧稿世界', '&n = 文件夹名');
    const t1 = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.ok(t1.startsWith('&n 旧稿世界\n'), '仅前置 &n');
    assert.ok(!t1.includes('（不应写入）'), '不改正文');
    assert.ok(t1.includes('正文第一段。'), '原文保留');
    assert.ok(readFileSync(join(folder, '.gitignore'), 'utf8').includes('.soliterra/'), '补 .soliterra/');
    assert.equal(execFileSync('git', ['rev-list', '--count', '--all'], { cwd: folder }).toString().trim(), '0', '已有仓库 → 不自动提交');
    // 再次采纳：& 行不重复
    v.close('旧稿世界');
    v.adoptFolder({ dir: folder });
    const t2 = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.equal(t2.split('&n ').length, 2, '&n 只出现一次');
    assert.ok(t2.includes('正文第一段。'));
  } finally {
    v.close('旧稿世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt：封面——已在文件夹内不复制；重名不同内容自动加序号', () => {
  const { root, v } = mkBare();
  const folder = join(root, '封面世界');
  try {
    mkdirSync(join(folder, 'assets'), { recursive: true });
    writeFileSync(join(folder, 'pic.png'), 'INNER', 'utf8');
    const info = v.adoptFolder({ dir: folder, coverPath: join(folder, 'pic.png') });
    assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').includes('&m pic.png'), '文件夹内图片 → 相对路径不复制');
    assert.ok(!existsSync(join(folder, 'assets', 'pic.png')));
    // 重名不同内容：已存在 assets/cover.png（大小不同）→ 新增 cover-1.png
    writeFileSync(join(folder, 'assets', 'cover.png'), 'OLD-XXXX', 'utf8');
    const c2 = join(root, 'cover.png');
    writeFileSync(c2, 'NEW', 'utf8');
    const info2 = v.adoptFolder({ dir: folder, coverPath: c2 });
    assert.ok(info2, 'ok');
    assert.ok(existsSync(join(folder, 'assets', 'cover-1.png')), '重名自动加序号');
    assert.equal(readFileSync(join(folder, 'assets', 'cover.png'), 'utf8'), 'OLD-XXXX', '原文件不动');
  } finally {
    v.close('封面世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt 守卫：世界库本身 / 库的父级 / 同名冲突', () => {
  const { root, lib, v } = mkBare();
  const other = join(root, '另一个'); 
  try {
    mkdirSync(other, { recursive: true });
    mkdirSync(join(lib, '重名'), { recursive: true });
    assert.throws(() => v.adoptFolder({ dir: lib }), /世界库本身/);
    assert.throws(() => v.adoptFolder({ dir: root }), /上级文件夹/);
    assert.throws(() => v.adoptFolder({ dir: join(root, '不存在的') }), /文件夹不存在/);
    const dup = join(root, '重名');
    mkdirSync(dup, { recursive: true });
    assert.throws(() => v.adoptFolder({ dir: dup }), /同名条目/);
    assert.throws(() => v.inspectFolder(dup), /同名条目/, 'inspect 同样预判冲突');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspect：文件夹信息（mdCount/hasReadme/insideLibrary）', () => {
  const { root, lib, v } = mkBare();
  const folder = join(root, '勘察');
  try {
    mkdirSync(join(folder, '子'), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# x\n', 'utf8');
    writeFileSync(join(folder, 'a.md'), '# a\n', 'utf8');
    writeFileSync(join(folder, '子', 'b.md'), '# b\n', 'utf8');
    const info = v.inspectFolder(folder);
    assert.equal(info.name, '勘察');
    assert.equal(info.mdCount, 3, '递归计数 md');
    assert.equal(info.hasReadme, true);
    assert.equal(info.hasGit, false);
    assert.equal(info.insideLibrary, false);
    assert.equal(info.path, realpathSync(folder));
    void lib;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('链接世界：renameWorld 连真实文件夹一起改名并重链；deleteWorld 仅摘链', () => {
  const { root, lib, v } = mkBare();
  const folder = join(root, '原名');
  try {
    mkdirSync(folder, { recursive: true });
    v.adoptFolder({ dir: folder, intro: 'x' });
    const info = v.renameWorld('原名', '新名');
    assert.equal(info.name, '新名');
    assert.ok(!existsSync(join(lib, '原名')), '旧链接已摘');
    assert.ok(lstatSync(join(lib, '新名')).isSymbolicLink(), '新链接建立');
    assert.ok(existsSync(join(root, '新名')), '真实文件夹已改名');
    assert.equal(realpathSync(join(lib, '新名')), realpathSync(join(root, '新名')));
    assert.ok(readFileSync(join(root, '新名', 'README.md'), 'utf8').startsWith('&n 新名'), '&n 同步');
    const r = v.deleteWorld('新名');
    assert.ok(r.unlinked, '返回 unlinked');
    assert.ok(!existsSync(join(lib, '新名')), '链接移除');
    assert.ok(existsSync(join(root, '新名')), '真实文件夹保留原位');
    assert.ok(!v.list().some((x) => x.id === '新名'), 'list 不再包含');
  } finally {
    v.close('新名');
    v.close('原名');
    rmSync(root, { recursive: true, force: true });
  }
});

test('根条目优先级：README.md 优先于 <世界名>.md', () => {
  const { root, lib } = mkBare();
  const w = join(lib, '双根');
  try {
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, 'README.md'), '&n 读我\n\n# 读我\n', 'utf8');
    writeFileSync(join(w, '双根.md'), '&n 旧根\n\n# 旧根\n', 'utf8');
    const v2 = new Vault(lib);
    const info = v2.worldInfo('双根');
    assert.equal(info.rootRel, 'README.md');
    assert.equal(info.name, '读我');
    v2.close('双根');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
