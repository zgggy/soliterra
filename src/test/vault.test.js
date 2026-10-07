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
    assert.ok(readme.includes('&m assets/covers/我的新世界.png'), '封面按世界名重命名（第 114 轮）');
    assert.ok(readme.includes('# 我的新世界') && readme.includes('一句话介绍'));
    assert.ok(existsSync(join(folder, 'assets', 'covers', '我的新世界.png')), '封面按世界名复制进 assets/covers/（第 114 轮）');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', '我的新世界.png'), 'utf8'), 'PNGDATA-1');
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

test('adopt 封面（第 119 轮改）：按世界名重命名 + 撞名序号 + 重采纳换封面按新名复制', async () => {
  const { root, v } = mkBare();
  const folder = join(root, '封面世界');
  try {
    mkdirSync(join(folder, 'assets'), { recursive: true });
    writeFileSync(join(folder, 'pic.png'), 'INNER', 'utf8');
    // 场景 A：文件夹内图片 → 复制成 covers/<世界名>（不再返回原相对路径）
    await v.adoptFolder({ dir: folder, coverPath: join(folder, 'pic.png') });
    assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').includes('&m assets/covers/封面世界.png'), '按世界名重命名');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', '封面世界.png'), 'utf8'), 'INNER', '内容复制落位');
    assert.ok(existsSync(join(folder, 'pic.png')), '源文件留存');
    // 场景 B：撞名不同内容 → 序号（防重名）——模拟「首次设置且目标名已被占」：先清 README &m
    writeFileSync(join(folder, 'assets', 'covers', '封面世界.png'), 'OLD-XXXX', 'utf8');
    writeFileSync(join(folder, 'README.md'), '&n 封面世界\n\n# 封面世界\n', 'utf8');
    const c2 = join(root, 'cover2.png');
    writeFileSync(c2, 'NEW-DIFFERENT', 'utf8');
    await v.adoptFolder({ dir: folder, coverPath: c2 });
    const readme2 = readFileSync(join(folder, 'README.md'), 'utf8');
    assert.ok(readme2.includes('&m assets/covers/封面世界-1.png'), '撞名 → -1 序号');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', '封面世界.png'), 'utf8'), 'OLD-XXXX', '既有文件不动');
    // 场景 C（第 119 轮）：重采纳换封面 → **不沿用旧名覆盖**（旧文件可能被共享）——序号新名
    const c3 = join(root, 'cover3.png');
    writeFileSync(c3, 'THIRD', 'utf8');
    await v.adoptFolder({ dir: folder, coverPath: c3 });
    assert.ok(readFileSync(join(folder, 'README.md'), 'utf8').includes('&m assets/covers/封面世界-2.png'), '换封面 → 序号新名');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', '封面世界-2.png'), 'utf8'), 'THIRD', '新图落位');
    assert.equal(readFileSync(join(folder, 'assets', 'covers', '封面世界-1.png'), 'utf8'), 'NEW-DIFFERENT', '旧封面文件不动（共享不被连带）');
  } finally {
    v.close('封面世界');
    rmSync(root, { recursive: true, force: true });
  }
});

test('setCover（第 119 轮改）：按条目名重命名 + 撞名序号 + 换封面按新名复制、旧文件全留', () => withWorld(async (v, w, root) => {
  mkdirSync(join(w, 'assets', 'covers'), { recursive: true });
  writeFileSync(join(w, 'assets', 'covers', '已有.png'), 'PNG-SOURCE', 'utf8');
  // 相对路径入口（assets 选择器）→ 复制成 covers/<条目名>（不再原样返回）
  const r1 = v.setCover('测试世界', '银湾.md', 'assets/covers/已有.png');
  assert.equal(r1.cover, 'assets/covers/银湾.png', '按条目名重命名');
  assert.equal(readFileSync(join(w, 'assets', 'covers', '银湾.png'), 'utf8'), 'PNG-SOURCE');
  assert.ok(existsSync(join(w, 'assets', 'covers', '已有.png')), '源文件留存');
  // 相对路径穿越 → 拒绝
  assert.throws(() => v.setCover('测试世界', '银湾.md', 'assets/../../越界.png'), /invalid path|图片不存在/);
  // 序号场景 = **同名不同条目**（二级/银湾.md 与银湾.md 同名）→ 目标名被占且内容不同 → 序号
  mkdirSync(join(w, '二级'), { recursive: true });
  writeFileSync(join(w, '二级', '银湾.md'), '# 同名条目\n', 'utf8');
  const outside = join(root, '外图.png');
  writeFileSync(outside, 'PNG2-LONGER', 'utf8');
  const r2 = v.setCover('测试世界', '二级/银湾.md', outside);
  assert.equal(r2.cover, 'assets/covers/银湾-1.png', '同名不同条目 → -1 序号（防重名）');
  assert.match(readFileSync(join(w, '二级', '银湾.md'), 'utf8'), /^&m assets\/covers\/银湾-1\.png$/m, '&m 指向新名');
  // 主条目换封面（第 119 轮）：**不再沿用旧名覆盖**——按条目名重新落名撞序号；旧文件全部原样保留
  const third = join(root, '三图.png');
  writeFileSync(third, 'THIRD', 'utf8');
  const r3 = v.setCover('测试世界', '银湾.md', third);
  assert.equal(r3.cover, 'assets/covers/银湾-2.png', '换封面 → 撞名序号新名（旧名不覆盖）');
  assert.equal(readFileSync(join(w, 'assets', 'covers', '银湾-2.png'), 'utf8'), 'THIRD', '新图落位');
  assert.equal(readFileSync(join(w, 'assets', 'covers', '银湾.png'), 'utf8'), 'PNG-SOURCE', '原封面文件不动');
  assert.equal(readFileSync(join(w, 'assets', 'covers', '银湾-1.png'), 'utf8'), 'PNG2-LONGER', '他条目封面不动');
  assert.match(readFileSync(join(w, '银湾.md'), 'utf8'), /^&m assets\/covers\/银湾-2\.png$/m, '&m 指向新名');
  // 幂等：重传同一张 → 内容一致复用（不堆 -3）
  const r4 = v.setCover('测试世界', '银湾.md', third);
  assert.equal(r4.cover, 'assets/covers/银湾-2.png', '同内容 sha1 复用');
  assert.ok(!existsSync(join(w, 'assets', 'covers', '银湾-3.png')), '不堆孤儿');
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

test('applyWorldInfo：&n/介绍首段/历法/时间线追加/封面设与移除（第 115 轮）', () => withWorld(async (v, w, root) => {
  writeFileSync(join(w, 'README.md'), '&n 旧名\n\n# 旧名\n\n第一段介绍。\n\n第二段保留。\n', 'utf8');
  const img = join(root, 'cv.png'); writeFileSync(img, 'PNG', 'utf8');
  const r = await v.applyWorldInfo('测试世界', {
    name: '新显示名',
    intro: '新介绍一句话。',
    calendar: 'CE 元年=0705',
    timeline: '&s 0705.01.01 &e 0705.12.31 &f 纪元开启 黄金纪元',
    cover: img,
  });
  const readme = readFileSync(join(w, 'README.md'), 'utf8');
  assert.match(readme, /^&n 新显示名\s*$/m, '显示名改（行内 upsert 允许尾空格；文件夹不动）');
  assert.ok(readme.includes('新介绍一句话。'), '首段替换');
  assert.ok(!readme.includes('第一段介绍'), '旧首段移除');
  assert.ok(readme.includes('第二段保留'), '第二段原样保留');
  assert.ok(readme.includes('<!-- calendar: CE 元年=0705 -->'), '历法注释写入');
  assert.match(readme, /^&m assets\/covers\//m, '封面设置（按世界名命名）');
  assert.equal(r.events, 1, '时间线 1 事件');
  assert.ok(existsSync(join(w, 'books', '时间线')), '时间线书建立');
  const r2 = await v.applyWorldInfo('测试世界', { timeline: '&s 0705.01.01 &e 0705.12.31 &f 纪元开启 黄金纪元' });
  assert.equal(r2.events, 0, '同名事件幂等跳过');
  await v.applyWorldInfo('测试世界', { intro: '', calendar: '', cover: '' });
  const readme2 = readFileSync(join(w, 'README.md'), 'utf8');
  assert.ok(!/calendar/.test(readme2), '历法注释删除');
  assert.ok(!readme2.includes('新介绍一句话'), '介绍段删除');
  assert.ok(!/^&m\s/m.test(readme2), '&m 移除');
  assert.ok(readme2.includes('第二段保留'), '其余正文不动');
}));

test('applyBookInfo：书名成对重命名 + 介绍/标签写入（第 115 轮）', () => withWorld(async (v, w) => {
  // 两段正文：首段替换、尾段保留（原 mk 内容整篇重写成可控结构）
  writeFileSync(join(w, '银湾.md'), '&n 银湾\n\n# 银湾\n\n首段会被替换。\n\n原有正文尾段。\n', 'utf8');
  const r = await v.applyBookInfo('测试世界', {
    path: '银湾.md', name: '银湾港', intro: '银湾港的介绍。', tags: '设定 地理',
  });
  assert.equal(r.path, '银湾港.md', '返回新 path');
  assert.ok(existsSync(join(w, '银湾港.md')), 'md 已重命名');
  assert.ok(existsSync(join(w, '银湾港')), '配对目录联动改名');
  const txt = readFileSync(join(w, '银湾港.md'), 'utf8');
  assert.ok(txt.includes('银湾港的介绍'), '首段替换');
  assert.ok(txt.includes('原有正文尾段'), '尾段保留');
  assert.match(txt, /^&t 设定 地理$/m, '标签写入');
  const idx = v.index('测试世界');
  assert.ok(idx.entry('银湾港.md'), '新路径入索引');
  assert.ok(!idx.entry('银湾.md'), '旧路径清');
}));

test('list 顺序：.order.json 自定义序在前、未入序排尾；改名保持秩（第 117 轮）', () => withWorld(async (v, w, root) => {
  for (const n of ['甲世界', '乙世界']) {
    mkdirSync(join(root, n), { recursive: true });
    writeFileSync(join(root, n, '读我.md'), '# 读我\n', 'utf8');
  }
  try {
    v.setWorldOrder(['乙世界', '测试世界']);
    assert.deepEqual(v.list().map((x) => x.id), ['乙世界', '测试世界', '甲世界'],
      '有秩者按秩在前；未入序的甲按名排尾');
    assert.ok(existsSync(join(root, '.order.json')), '顺序落盘 worldsDir/.order.json');
    // 新世界（未入序）同样排尾
    mkdirSync(join(root, '新世界'), { recursive: true });
    writeFileSync(join(root, '新世界', '读我.md'), '# 读我\n', 'utf8');
    assert.equal(v.list().at(-1).id, '新世界', '新世界在序尾');
    // 改名 → 顺序表内 id 同步（否则改名世界掉回名序）
    v.renameWorld('测试世界', '测改世界');
    assert.deepEqual(v.list().map((x) => x.id), ['乙世界', '测改世界', '甲世界', '新世界'], '改名保持秩');
  } finally {
    v.close('测改世界'); v.close('甲世界'); v.close('乙世界'); v.close('新世界');
  }
}));

test('setCover：共享封面换图不连带——只改名复制上传图，项目内旧文件一律不动（第 119 轮）', () => withWorld(async (v, w, root) => {
  mkdirSync(join(w, 'assets', 'covers'), { recursive: true });
  writeFileSync(join(w, 'assets', 'covers', '共享.png'), 'SHARED-OLD', 'utf8');
  // 两张卡的 &m 指向同一文件（共享封面——资产选择器原样选用 / 同图幂等复用都会造成）
  writeFileSync(join(w, '银湾.md'), '&m assets/covers/共享.png\n\n# 银湾\n', 'utf8');
  writeFileSync(join(w, '黄金时代', '北伐.md'), '&m assets/covers/共享.png\n\n# 北伐\n', 'utf8');
  // 给银湾重新上传封面（外部图片）——旧规则会把 共享.png 覆盖掉，北伐的封面被连带改掉
  const up = join(root, '新图.png');
  writeFileSync(up, 'NEW-IMG', 'utf8');
  const r = v.setCover('测试世界', '银湾.md', up);
  assert.equal(readFileSync(join(w, 'assets', 'covers', '共享.png'), 'utf8'), 'SHARED-OLD', '共享旧文件原样保留');
  assert.match(readFileSync(join(w, '黄金时代', '北伐.md'), 'utf8'), /^&m assets\/covers\/共享\.png$/m, '另一张卡 &m 不变（封面不被连带）');
  assert.equal(r.cover, 'assets/covers/银湾.png', '上传图按条目名改名复制');
  assert.equal(readFileSync(join(w, 'assets', 'covers', '银湾.png'), 'utf8'), 'NEW-IMG', '新图内容落位');
  // 二次换封面 → 序号新名；上一版副本也不动
  const up2 = join(root, '新图2.png');
  writeFileSync(up2, 'NEW-IMG-2', 'utf8');
  const r2 = v.setCover('测试世界', '银湾.md', up2);
  assert.equal(r2.cover, 'assets/covers/银湾-1.png', '二次换封面 → 序号新名');
  assert.equal(readFileSync(join(w, 'assets', 'covers', '银湾.png'), 'utf8'), 'NEW-IMG', '上一版副本不动');
}));
