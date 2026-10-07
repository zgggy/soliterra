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
import { collectMarkdown } from '../lib/indexer.js';

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
  try { await fn(v, w, root); }
  finally { v.close('测试世界'); rmSync(root, { recursive: true, force: true }); }
};

test('renameEntry：纯目录节点改名（子文件保留、配对 md 若有则联动、&n 同步）', () => withWorld(async (v, w) => {
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

test('deleteEntry：纯目录节点整书入回收站（+ 配对 md 联动）', () => withWorld(async (v, w) => {
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

test('renameEntry 仍支持 md 路径（原行为不回退）', () => withWorld(async (v, w) => {
  const r = v.renameEntry('测试世界', '银湾.md', '银湾湾');
  assert.equal(r.path, '银湾湾.md');
  assert.ok(existsSync(join(w, '银湾湾.md')) && existsSync(join(w, '银湾湾', '附记.md')));
}));

test('worldInfo/list 带 dir：世界真实存储位置（第 87 轮）', () => withWorld(async (v, w) => {
  const info = v.worldInfo('测试世界');
  assert.equal(info.dir, realpathSync(w), 'worldInfo.dir = 世界目录绝对路径');
  const li = v.list();
  assert.equal(li.find((x) => x.id === '测试世界').dir, realpathSync(w), 'list 条目带 dir');
}));

test('符号链接世界：dir 显示真实目标（库外文件夹接入）', async () => {
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

test('adopt：空文件夹（库外）→ README.md + assets/covers/ 封面 + .gitignore + git init + 链接登记', async () => {
  const { root, lib, v } = mkBare();
  const folder = join(root, '我的新世界');
  const cover = join(root, 'cover.png');
  try {
    mkdirSync(folder);
    writeFileSync(cover, 'PNGDATA-1', 'utf8');
    const info = await v.adoptFolder({ dir: folder, intro: '一句话介绍', coverPath: cover });
    assert.equal(info.name, '我的新世界');
    assert.equal(info.rootRel, 'README.md');
    assert.equal(info.linked, true, '库外文件夹 → 链接登记');
    assert.equal(info.dir, realpathSync(folder));
    const readme = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.ok(readme.startsWith('&n 我的新世界'), '&n 首行');
    assert.ok(readme.includes('&m assets/covers/cover.png'));
    assert.ok(readme.includes('# 我的新世界') && readme.includes('一句话介绍'));
    assert.ok(existsSync(join(folder, 'assets', 'covers', 'cover.png')), '封面复制进 assets/covers/（第 89 轮规范）');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', 'cover.png'), 'utf8'), 'PNGDATA-1');
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

test('adopt：库内直接子文件夹 → 原地（无链接）', async () => {
  const { root, lib, v } = mkBare();
  const folder = join(lib, '库内世界');
  try {
    mkdirSync(folder, { recursive: true });
    const info = await v.adoptFolder({ dir: folder, intro: '库内的' });
    assert.equal(info.id, '库内世界');
    assert.equal(info.linked, false, '直接子文件夹不建链接');
    assert.ok(!lstatSync(folder).isSymbolicLink());
    assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').includes('库内的'));
  } finally {
    v.close('库内世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt：已有 README.md → 正文一字不动、只补 & 行、重复采纳幂等', async () => {
  const { root, v } = mkBare();
  const folder = join(root, '旧稿世界');
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# 我的旧说明\n\n正文第一段。\n', 'utf8');
    writeFileSync(join(folder, '.gitignore'), 'node_modules/\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: folder });
    const info = await v.adoptFolder({ dir: folder, intro: '（不应写入）', coverPath: '' });
    assert.equal(info.name, '旧稿世界', '&n = 文件夹名');
    const t1 = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.ok(t1.startsWith('&n 旧稿世界\n'), '仅前置 &n');
    assert.ok(!t1.includes('（不应写入）'), '不改正文');
    assert.ok(t1.includes('正文第一段。'), '原文保留');
    assert.ok(readFileSync(join(folder, '.gitignore'), 'utf8').includes('.soliterra/'), '补 .soliterra/');
    assert.equal(execFileSync('git', ['rev-list', '--count', '--all'], { cwd: folder }).toString().trim(), '0', '已有仓库 → 不自动提交');
    // 再次采纳：& 行不重复
    v.close('旧稿世界');
    await v.adoptFolder({ dir: folder });
    const t2 = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.equal(t2.split('&n ').length, 2, '&n 只出现一次');
    assert.ok(t2.includes('正文第一段。'));
  } finally {
    v.close('旧稿世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt：封面——已在文件夹内不复制；重名不同内容自动加序号', async () => {
  const { root, v } = mkBare();
  const folder = join(root, '封面世界');
  try {
    mkdirSync(join(folder, 'assets'), { recursive: true });
    writeFileSync(join(folder, 'pic.png'), 'INNER', 'utf8');
    const info = await v.adoptFolder({ dir: folder, coverPath: join(folder, 'pic.png') });
    assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').includes('&m pic.png'), '文件夹内图片 → 相对路径不复制');
    assert.ok(!existsSync(join(folder, 'assets', 'pic.png')));
    // 重名不同内容：已存在 assets/covers/cover.png（大小不同）→ 新增 cover-1.png
    mkdirSync(join(folder, 'assets', 'covers'), { recursive: true });
    writeFileSync(join(folder, 'assets', 'covers', 'cover.png'), 'OLD-XXXX', 'utf8');
    const c2 = join(root, 'cover.png');
    writeFileSync(c2, 'NEW', 'utf8');
    const info2 = await v.adoptFolder({ dir: folder, coverPath: c2 });
    assert.ok(info2, 'ok');
    assert.ok(existsSync(join(folder, 'assets', 'covers', 'cover-1.png')), '重名自动加序号');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', 'cover.png'), 'utf8'), 'OLD-XXXX', '原文件不动');
  } finally {
    v.close('封面世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt 守卫：世界库本身 / 库的父级 / 同名冲突', async () => {
  const { root, lib, v } = mkBare();
  const other = join(root, '另一个'); 
  try {
    mkdirSync(other, { recursive: true });
    mkdirSync(join(lib, '重名'), { recursive: true });
    await assert.rejects(() => v.adoptFolder({ dir: lib }), /世界库本身/);
    await assert.rejects(() => v.adoptFolder({ dir: root }), /上级文件夹/);
    await assert.rejects(() => v.adoptFolder({ dir: join(root, '不存在的') }), /文件夹不存在/);
    const dup = join(root, '重名');
    mkdirSync(dup, { recursive: true });
    await assert.rejects(() => v.adoptFolder({ dir: dup }), /同名条目/);
    assert.throws(() => v.inspectFolder(dup), /同名条目/, 'inspect 同样预判冲突');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspect：文件夹信息（mdCount/hasReadme/insideLibrary）', async () => {
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

test('链接世界：renameWorld 连真实文件夹一起改名并重链；unmanageWorld 仅摘链（第 90 轮）', async () => {
  const { root, lib, v } = mkBare();
  const folder = join(root, '原名');
  try {
    mkdirSync(folder, { recursive: true });
    await v.adoptFolder({ dir: folder, intro: 'x' });
    const info = v.renameWorld('原名', '新名');
    assert.equal(info.name, '新名');
    assert.ok(!existsSync(join(lib, '原名')), '旧链接已摘');
    assert.ok(lstatSync(join(lib, '新名')).isSymbolicLink(), '新链接建立');
    assert.ok(existsSync(join(root, '新名')), '真实文件夹已改名');
    assert.equal(realpathSync(join(lib, '新名')), realpathSync(join(root, '新名')));
    assert.ok(readFileSync(join(root, '新名', 'README.md'), 'utf8').startsWith('&n 新名'), '&n 同步');
    const r = v.unmanageWorld('新名');
    assert.equal(r.mode, 'unlinked', '链接世界 → 摘链');
    assert.ok(!existsSync(join(lib, '新名')), '链接移除');
    assert.ok(existsSync(join(root, '新名')), '真实文件夹保留原位');
    assert.ok(!v.list().some((x) => x.id === '新名'), 'list 不再包含');
  } finally {
    v.close('新名');
    v.close('原名');
    rmSync(root, { recursive: true, force: true });
  }
});

test('根条目兜底：世界名书迁入 books/ 后仍认（第 89 轮）', async () => {
  const { root, lib } = mkBare();
  const w = join(lib, '卡纳利斯');
  try {
    mkdirSync(join(w, 'books'), { recursive: true });
    writeFileSync(join(w, 'books', '卡纳利斯.md'), '&n 卡纳利斯\n&m assets/covers/c.png\n\n# 卡纳利斯\n', 'utf8');
    const v2 = new Vault(lib);
    const info = v2.worldInfo('卡纳利斯');
    assert.equal(info.rootRel, 'books/卡纳利斯.md');
    assert.equal(info.name, '卡纳利斯');
    assert.equal(info.cover, 'assets/covers/c.png');
    v2.close('卡纳利斯');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('根条目优先级：README.md 优先于 <世界名>.md', async () => {
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

test('结构规范（第 89 轮）：_initWorldFolder 建 books/ 容器 + 时间线 → books/时间线/ 成对书', async () => {
  const { root, v } = mkBare();
  const folder = join(root, '时间线世界');
  try {
    mkdirSync(folder, { recursive: true });
    const info = await v.adoptFolder({ dir: folder, intro: 'x', timeline: '&s 0705.01.01 &f 纪元开启 黄金纪元' });
    assert.ok(existsSync(join(folder, 'books')), 'books/ 容器');
    assert.ok(existsSync(join(folder, 'books', '时间线.md')), '时间线配对条目');
    assert.ok(existsSync(join(folder, 'books', '时间线', '01-纪元开启.md')), '事件条目在 books/时间线/ 下');
    assert.ok(!existsSync(join(folder, '时间线')), '世界根不再放 时间线/');
    assert.equal(info.rootRel, 'README.md');
  } finally {
    v.close('时间线世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('结构规范：saveAsset → assets/images/（正文图片之家）', async () => {
  const { root, v } = mkBare();
  const folder = join(root, '图世界');
  try {
    mkdirSync(folder, { recursive: true });
    await v.adoptFolder({ dir: folder });
    const rel = v.saveAsset('图世界', '照片 1.png', Buffer.from('IMG'));
    assert.equal(rel, 'assets/images/照片_1.png');
    assert.ok(existsSync(join(folder, 'assets', 'images', '照片_1.png')));
    const rel2 = v.saveAsset('图世界', '照片 1.png', Buffer.from('IMG2'));
    assert.equal(rel2, 'assets/images/照片_1-2.png', '重名加序号');
  } finally {
    v.close('图世界');
    rmSync(root, { recursive: true, force: true });
  }
});

// ============ 第 90 轮：取消管理 + 归档 ============

test('unmanageWorld：库内世界 → 忽略表（文件夹原地保留）；再采纳恢复管理', async () => {
  const { root, lib, v } = mkBare();
  const w = join(lib, '库内世界');
  try {
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, 'README.md'), '&n 库内世界\n\n# 库内世界\n', 'utf8');
    assert.ok(v.list().some((x) => x.id === '库内世界'), '先在列表');
    const r = v.unmanageWorld('库内世界');
    assert.equal(r.mode, 'ignored');
    assert.ok(existsSync(w), '文件夹原地保留');
    assert.ok(!v.list().some((x) => x.id === '库内世界'), 'list 不再包含');
    assert.ok(existsSync(join(lib, '.unmanaged.json')), '忽略表落盘');
    await v.adoptFolder({ dir: w });   // 重新采纳 = 恢复管理
    assert.ok(v.list().some((x) => x.id === '库内世界'), '恢复管理');
    assert.ok(!JSON.parse(readFileSync(join(lib, '.unmanaged.json'), 'utf8')).ids.includes('库内世界'), '忽略表已清该名');
  } finally {
    v.close('库内世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveBook（配对书）：md → .md.arc，子树从索引隐藏；unarchiveBook 还原并重扫', async () => {
  const { root, lib, v } = mkBare();
  const w = join(lib, '书世界');
  try {
    mkdirSync(join(w, 'books', '卷一卷'), { recursive: true });
    writeFileSync(join(w, 'README.md'), '&n 书世界\n\n# 书世界\n', 'utf8');
    writeFileSync(join(w, 'books', '卷一卷.md'), '&n 卷一卷\n\n# 卷一卷\n', 'utf8');
    writeFileSync(join(w, 'books', '卷一卷', '第一章.md'), '# 第一章\n', 'utf8');
    const v2 = new Vault(lib);
    assert.equal(v2.index('书世界').stats().entries, 3);
    const r = v2.archiveBook('书世界', 'books/卷一卷');
    assert.equal(r.archived, 'books/卷一卷.md.arc');
    assert.ok(existsSync(join(w, 'books', '卷一卷.md.arc')), 'md 已改名 .arc');
    assert.ok(!existsSync(join(w, 'books', '卷一卷.md')));
    assert.ok(existsSync(join(w, 'books', '卷一卷', '第一章.md')), '配对目录原样保留');
    assert.equal(collectMarkdown(w).filter((x) => x.startsWith('books/卷一卷')).length, 0, 'collectMarkdown 隐藏整棵');
    assert.equal(v2.index('书世界').stats().entries, 1, '索引只剩 README');
    const r2 = v2.unarchiveBook('书世界', 'books/卷一卷');
    assert.equal(r2.restored, 'books/卷一卷');
    assert.ok(existsSync(join(w, 'books', '卷一卷.md')));
    assert.equal(v2.index('书世界').stats().entries, 3, '还原后子树重扫回索引');
    v2.close('书世界');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveBook（纯目录节点）：写 .arc 标记；unarchiveBook 删标记、目录保留', async () => {
  const { root, lib, v } = mkBare();
  const w = join(lib, '目录世界');
  try {
    mkdirSync(join(w, 'books', '工具'), { recursive: true });
    writeFileSync(join(w, 'books', '工具', '脚本.md'), '# 脚本\n', 'utf8');
    writeFileSync(join(w, 'README.md'), '&n 目录世界\n\n# 目录世界\n', 'utf8');
    const v2 = new Vault(lib);
    v2.archiveBook('目录世界', 'books/工具');
    const arc = join(w, 'books', '工具.md.arc');
    assert.ok(existsSync(arc), '标记文件');
    assert.ok(existsSync(join(w, 'books', '工具', '脚本.md')), '目录内容保留');
    assert.equal(v2.index('目录世界').stats().entries, 1);
    v2.unarchiveBook('目录世界', 'books/工具');
    assert.ok(!existsSync(arc), '还原 = 删标记');
    assert.ok(existsSync(join(w, 'books', '工具', '脚本.md')), '目录原样');
    assert.equal(v2.index('目录世界').stats().entries, 2);
    v2.close('目录世界');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveEntry：条目（+ 同名文件夹）→ books/archives/ + `&x` 原路径；unarchiveEntry 原样还原', async () => {
  const { root, lib, v } = mkBare();
  const w = join(lib, '归档世界');
  try {
    mkdirSync(join(w, 'books', '黄金时代', '北伐'), { recursive: true });
    writeFileSync(join(w, 'README.md'), '&n 归档世界\n\n# 归档世界\n', 'utf8');
    writeFileSync(join(w, 'books', '黄金时代.md'), '&n 黄金时代\n\n# 黄金时代\n', 'utf8');
    writeFileSync(join(w, 'books', '黄金时代', '北伐.md'), '&s 0662.08.17\n\n# 北伐\n', 'utf8');
    writeFileSync(join(w, 'books', '黄金时代', '北伐', '附记.md'), '# 附记\n', 'utf8');
    const v2 = new Vault(lib);
    const r = v2.archiveEntry('归档世界', 'books/黄金时代/北伐.md');
    assert.equal(r.archived, 'books/archives/黄金时代/北伐.md');
    const moved = readFileSync(join(w, 'books', 'archives', '黄金时代', '北伐.md'), 'utf8');
    assert.ok(moved.startsWith('&x books/黄金时代/北伐.md'), '记录归档前位置');
    assert.ok(existsSync(join(w, 'books', 'archives', '黄金时代', '北伐', '附记.md')), '同名文件夹随迁');
    assert.ok(!existsSync(join(w, 'books', '黄金时代', '北伐.md')));
    assert.equal(collectMarkdown(w).filter((x) => x.includes('archives')).length, 0, '归档区不收集');
    const list = v2.listArchives('归档世界');
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].orig, 'books/黄金时代/北伐.md');
    assert.equal(list.entries[0].title, '北伐');
    const r2 = v2.unarchiveEntry('归档世界', 'books/archives/黄金时代/北伐.md');
    assert.equal(r2.restored, 'books/黄金时代/北伐.md');
    const back = readFileSync(join(w, 'books', '黄金时代', '北伐.md'), 'utf8');
    assert.ok(!back.includes('&x'), '还原后去掉 &x');
    assert.ok(existsSync(join(w, 'books', '黄金时代', '北伐', '附记.md')), '同名文件夹还原');
    v2.close('归档世界');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectMarkdown：.md.arc 书整棵隐藏 + books/archives 整目录隐藏', async () => {
  const root = mkdtempSync(join(tmpdir(), 'soliterra-collect-'));
  try {
    mkdirSync(join(root, 'books', '甲'), { recursive: true });
    mkdirSync(join(root, 'books', '乙'), { recursive: true });
    mkdirSync(join(root, 'books', 'archives', '甲'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# R\n', 'utf8');
    writeFileSync(join(root, 'books', '甲', '一.md'), '# 一\n', 'utf8');
    writeFileSync(join(root, 'books', '甲.md.arc'), '&n 甲\n', 'utf8');
    writeFileSync(join(root, 'books', '乙.md'), '&n 乙\n', 'utf8');
    writeFileSync(join(root, 'books', '乙', '二.md'), '# 二\n', 'utf8');
    writeFileSync(join(root, 'books', 'archives', '甲', '一.md'), '# 一\n', 'utf8');
    const got = collectMarkdown(root);
    assert.deepEqual(got.sort(), ['README.md', 'books/乙.md', 'books/乙/二.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('新建世界自动 git init 且分支为 main；已是仓库（其它分支）不动（第 90 轮补充）', async () => {
  const { root, v } = mkBare();
  const folder = join(root, '主分支世界');
  const other = join(root, '老分支');
  try {
    mkdirSync(folder, { recursive: true });
    await v.adoptFolder({ dir: folder });
    assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: folder }).toString().trim(), 'main', '新世界 = main 分支');
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: folder }).toString().trim(), 'init: 创建世界 主分支世界');
    v.close('主分支世界');
    // 已是仓库：分支与提交历史一切不动
    mkdirSync(other, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: other });
    writeFileSync(join(other, 'x.md'), '# x\n', 'utf8');
    await v.adoptFolder({ dir: other });
    assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: other }).toString().trim(), 'master', '已有仓库不改分支');
    assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: other }), '不自动提交');
    v.close('老分支');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 第 91 轮：目录内 &r 自定义排序（拖动改序的服务端语义）
test('setOrder：整层 &r 连续化重写 + tree() 按序输出；纯目录跳过；越层拒绝；同行多键保留', () => withWorld(async (v, w) => {
  writeFileSync(join(w, '黄金时代', '甲.md'), '# 甲\n', 'utf8');
  writeFileSync(join(w, '黄金时代', '乙.md'), '&r 9\n\n# 乙\n', 'utf8');
  writeFileSync(join(w, '黄金时代', '丙.md'), '&r 5 &t 设定\n\n# 丙\n', 'utf8');
  mkdirSync(join(w, '黄金时代', '子卷'));   // 纯目录同层节点（无配对 md → &r 无处写，应跳过）
  v.index('测试世界');
  // 新顺序：乙（旧 &r 9 → 原位改 1）、甲（前置 &r 2）、北伐（前置 &r 3）、丙（同行 &t 保留）、纯目录占位 → 跳过
  const r = v.setOrder('测试世界', '黄金时代',
    ['黄金时代/乙.md', '黄金时代/甲.md', '黄金时代/北伐.md', '黄金时代/丙.md', '黄金时代/子卷']);
  assert.equal(r.updated, 4, '纯目录（无 md）跳过不报错');
  assert.match(readFileSync(join(w, '黄金时代', '乙.md'), 'utf8'), /^&r 1$/m, '已有 &r 原位改值');
  assert.match(readFileSync(join(w, '黄金时代', '甲.md'), 'utf8'), /^&r 2\n# 甲/, '无 &r 前置一行');
  assert.match(readFileSync(join(w, '黄金时代', '北伐.md'), 'utf8'), /^&r 3\n&s 0662\.08\.17/, '北伐 &r 3');
  assert.match(readFileSync(join(w, '黄金时代', '丙.md'), 'utf8'), /^&r 4 &t 设定$/m, '同行其他键保留');
  // tree()：带 &r 的子女升序在前（拖动结果即渲染顺序）
  const node = v.index('测试世界').tree().children.find((c) => c.name === '黄金时代');
  assert.deepEqual(node.children.map((c) => c.name), ['乙', '甲', '北伐', '丙']);
  // 越层清单拒绝（防误写他层）
  assert.throws(() => v.setOrder('测试世界', '黄金时代', ['银湾/附记.md']), /越层/);
}));

test('gitStatus：files 对象化 {status, path}（第 96 轮：未提交行右侧文件清单用）', async () => {
  const { root, v, w } = mk();
  try {
    // mk 的目录不是仓库 → 先 init + 基线提交（与 create 世界的初始状态一致）
    const inited = await v._gitInitCommit(w, 'init: baseline');
    assert.equal(inited, true, 'git init + 首提交成功');
    // 改一个已跟踪文件 + 新增一个未跟踪文件
    writeFileSync(join(w, '银湾.md'), '&n 银湾港\n\n# 改动\n', 'utf8');
    writeFileSync(join(w, '新增条目.md'), '# 新\n', 'utf8');
    const st = await v.gitStatus('测试世界');
    assert.equal(st.dirty, 2, '两个未提交');
    const byPath = Object.fromEntries(st.files.map((f) => [f.path, f.status]));
    assert.equal(byPath['银湾.md'], 'M', '已跟踪文件改动 = M');
    assert.equal(byPath['新增条目.md'], '??', '未跟踪新文件 = ??');
    assert.equal(typeof st.files[0].path, 'string', 'path 是字符串');
  } finally { v.close('测试世界'); rmSync(root, { recursive: true, force: true }); }
});

test('setCover：世界内相对路径直接用（不复制）；绝对路径复制进 assets/covers（第 97 轮）', () => withWorld(async (v, w, root) => {
  mkdirSync(join(w, 'assets', 'covers'), { recursive: true });
  writeFileSync(join(w, 'assets', 'covers', '已有.png'), 'PNG', 'utf8');
  // 相对路径（assets 选择器入口）→ 原样写 &m（mk fixture 无 README → 用书条目）
  const r1 = v.setCover('测试世界', '银湾.md', 'assets/covers/已有.png');
  assert.equal(r1.cover, 'assets/covers/已有.png', '相对路径不复制');
  assert.match(readFileSync(join(w, '银湾.md'), 'utf8'), /^&m assets\/covers\/已有\.png$/m);
  // 相对路径穿越 → 拒绝
  assert.throws(() => v.setCover('测试世界', '银湾.md', 'assets/../../越界.png'), /invalid path|图片不存在/);
  // 绝对路径 → 复制
  const outside = join(root, '外图.png');   // 世界外 → 才走复制分支
  writeFileSync(outside, 'PNG2', 'utf8');
  const r2 = v.setCover('测试世界', '银湾.md', outside);
  assert.ok(r2.cover.startsWith('assets/covers/'), '复制到 covers');
  assert.match(readFileSync(join(w, '银湾.md'), 'utf8'), new RegExp(`^&m ${r2.cover.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), '&m 原位改值');
}));

test('moveEntry：散条目移进叶子 → 目标叶子 mkdir 成为配对书（第 108 轮）', () => withWorld(async (v, w) => {
  writeFileSync(join(w, '散入.md'), '# 散\n', 'utf8');
  v.index('测试世界');
  const r = v.moveEntry('测试世界', '散入.md', '黄金时代/北伐');
  assert.equal(r.moves.length, 1);
  assert.ok(existsSync(join(w, '黄金时代', '北伐', '散入.md')), '移入叶子并创建其目录');
  assert.ok(existsSync(join(w, '黄金时代', '北伐.md')), '目标叶 md 仍在 → 北伐成为配对书（md+目录）');
  assert.ok(!existsSync(join(w, '散入.md')), '根层原文件已移走');
  const idx = v.index('测试世界');
  assert.ok(idx.entry('黄金时代/北伐/散入.md'), '新路径已入索引');
  assert.ok(!idx.entry('散入.md'), '旧路径已清');
}));
