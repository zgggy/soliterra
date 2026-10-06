// 第 78 轮：工具库测试（备份剪枝 + apply 端到端）。临时目录操作，零外依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, pruneBackups, lint, scanStructure, applyStructure } from '../lib/tools.js';

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

// ── 第 82 轮：时间上手（候选提取纯函数 + 扫描） ────────────────────
import { parseYearCell, fmtOnboardYear, parseTimelineTable, scanOnboard } from '../lib/tools.js';

test('parseYearCell：年份单元格全样式（约/前/区间/不可机械化的）', () => {
  assert.deepEqual(parseYearCell('约770'), { y: 770, y2: null });
  assert.deepEqual(parseYearCell('前300'), { y: -300, y2: null });
  assert.deepEqual(parseYearCell('657–700'), { y: 657, y2: 700 });          // en dash
  assert.deepEqual(parseYearCell('约前100–0'), { y: -100, y2: 0 });
  assert.deepEqual(parseYearCell('约80-200'), { y: 80, y2: 200 });           // hyphen
  assert.equal(parseYearCell('远古'), null);                                  // 不机械化
  assert.equal(parseYearCell('至今'), null);
  assert.equal(parseYearCell('年'), null);                                    // 表头
  assert.equal(parseYearCell('----'), null);                                  // 分隔行
  assert.equal(parseYearCell('前200-'), null);                                // 残缺 → 保守跳过
  assert.equal(parseYearCell(''), null);
});

test('fmtOnboardYear：一律 yyyy.*.*（月日未知诚实模糊；负年 = 前纪）', () => {
  assert.equal(fmtOnboardYear(770), '0770.*.*');
  assert.equal(fmtOnboardYear(-300), '-0300.*.*');
  assert.equal(fmtOnboardYear(0), '0000.*.*');
  assert.equal(fmtOnboardYear(4090), '4090.*.*');
});

test('parseTimelineTable：只认 | 年 | 事件 | … | 行', () => {
  const md = `# 时间线
| 年 | 事件 | 要点 |
|----|------|------|
| 远古 | 三力 | 不可机械化 |
| 约770 | 灵矿航道之乱 | 要点 |
| 前300–前100 | 霜脊联盟 | 要点 |
| 657–700 | 弗拉维朝 | 要点 |
| 874 | 大崩坏 | 要点 |
非表格行
`;
  const rows = parseTimelineTable(md);
  assert.equal(rows.length, 4, '远古行跳过');
  assert.deepEqual(rows[0], { y: 770, y2: null, event: '灵矿航道之乱' });
  assert.deepEqual(rows[1], { y: -300, y2: -100, event: '霜脊联盟' });
  assert.deepEqual(rows[2], { y: 657, y2: 700, event: '弗拉维朝' });
  assert.deepEqual(rows[3], { y: 874, y2: null, event: '大崩坏' });
});

test('scanOnboard：时间线匹配（双向包含/多命中取最早/带区间附 &e）+ 无候选 manual + 幂等 + old 跳过', () => {
  const dir = mkWorld();
  writeFileSync(join(dir, '0.0 详细时间线.md'),
    '| 年 | 事件 | 要点 |\n|----|------|------|\n| 657–700 | 弗拉维朝 | x |\n| 702 | 北伐令 | x |\n| 662 | 北伐前期 | x |\n| 874 | 大崩坏 | x |\n', 'utf8');
  writeFileSync(join(dir, '北伐.md'), '# 1.7 北伐\n\n正文\n', 'utf8');             // 多命中（北伐令/北伐前期）→ 取最早 662
  writeFileSync(join(dir, '弗拉维朝.md'), '# 弗拉维朝\n\n正文\n', 'utf8');             // 单命中带区间 → &s &e 成对
  writeFileSync(join(dir, '星月.md'), '# 星月\n\n正文提 0705.09.10 隐现\n', 'utf8');  // 源 A 不中 → 源 B 正文日期
  writeFileSync(join(dir, '设定.md'), '# 设定\n\n无任何日期\n', 'utf8');              // 无候选 → manual
  writeFileSync(join(dir, '已有.md'), '&s 0500.01.01\n\n# 已有\n', 'utf8');          // 幂等跳过
  mkdirSync(join(dir, 'old'), { recursive: true });
  writeFileSync(join(dir, 'old', '旧稿.md'), '# 旧稿\n\n正文 0662.01.01\n', 'utf8'); // old 跳过
  const items = scanOnboard(dir);
  const byPath = Object.fromEntries(items.map((x) => [x.path, x]));
  const fix = items.filter((x) => !x.manual);
  const man = items.filter((x) => x.manual);
  assert.equal(fix.length, 3, '三个可写候选：北伐/弗拉维朝/星月');
  assert.equal(man.length, 1, '一个 manual 提示');
  assert.equal(man[0].path, '设定.md');
  assert.match(byPath['北伐.md'].after, /^&s 0662\.\*\.\*\n/, '多命中取最早年 662');
  assert.match(byPath['弗拉维朝.md'].after, /^&s 0657\.\*\.\* &e 0700\.\*\.\*/, '单命中区间成对 &s &e');
  assert.match(byPath['星月.md'].after, /^&s 0705\.09\.10\n/, '正文点分日期兜底');
  assert.match(byPath['北伐.md'].src, /时间线/, '来源标注');
  assert.equal(byPath['北伐.md'].before, '# 1.7 北伐', '锚行 = 首个非空行');
  assert.ok(!items.some((x) => x.path === '已有.md'), '已有 &s 幂等跳过');
  assert.ok(!items.some((x) => x.path.startsWith('old/')), 'old 目录跳过');
  rmSync(dir, { recursive: true, force: true });
});

test('scanOnboard→apply：候选应用后条目带上 &s（备份含改前原文）', () => {
  const dir = mkWorld();
  writeFileSync(join(dir, '0.0 时间线.md'), '| 年 | 事件 | 要点 |\n|----|------|------|\n| 662 | 大崩坏 | x |\n', 'utf8');
  writeFileSync(join(dir, '崩坏.md'), '# 崩坏\n\n正文\n', 'utf8');
  const items = scanOnboard(dir).filter((x) => !x.manual);
  assert.equal(items.length, 1);
  const res = apply(dir, 'onboard', items);
  assert.equal(res.changed, 1);
  assert.match(readFileSync(join(dir, '崩坏.md'), 'utf8'), /^&s 0662\.\*\.\*\n# 崩坏/);
  const newest = readdirSync(join(dir, '.soliterra')).filter((n) => n.startsWith('backup-')).sort().pop();
  assert.equal(readFileSync(join(dir, '.soliterra', newest, '崩坏.md'), 'utf8'), '# 崩坏\n\n正文\n');
  rmSync(dir, { recursive: true, force: true });
});

// ── 第 86 轮：lint 悬空双链附漂移近似（§13） ────────────────────
test('lint：悬空双链与现存标题编辑距离 ≤2 → 消息附「疑似漂移 →《正名》」', () => {
  const dir = mkWorld();
  writeFileSync(join(dir, '血色婚礼.md'), '# 血色婚礼\n', 'utf8');
  writeFileSync(join(dir, 'a.md'), '# 甲\n\n见 [[血色婚札]] 与 [[毫无关联的名字XYZ]]。\n', 'utf8');
  const items = lint(dir);
  const dang = items.filter((x) => x.kind === 'dangling');
  assert.equal(dang.length, 2, '两个悬空');
  const drift = dang.find((x) => x.message.includes('血色婚札'));
  const plain = dang.find((x) => x.message.includes('毫无关联'));
  assert.match(drift.message, /疑似漂移 →《血色婚礼》/, '近似（距离≤2）附正名建议');
  assert.match(drift.message, /工具箱/, '提示可归并路径');
  assert.ok(!plain.message.includes('疑似漂移'), '无近似不提示');
  rmSync(dir, { recursive: true, force: true });
});

// ============ 第 89 轮：目录结构规范化 ============

const mkStructuredWorld = () => {
  const dir = mkWorld();
  writeFileSync(join(dir, 'README.md'), '&n 卡纳利斯\n\n# 卡纳利斯\n', 'utf8');
  writeFileSync(join(dir, '散记.md'), '&m assets/concepts/cover.png\n\n# 散记\n\n![图](assets/imported/old.png)\n', 'utf8');
  mkdirSync(join(dir, '黄金时代'), { recursive: true });
  writeFileSync(join(dir, '黄金时代.md'), '&n 黄金时代\n\n# 黄金时代\n', 'utf8');
  writeFileSync(join(dir, '黄金时代', '北伐.md'), '&s 0662.08.17\n\n# 北伐\n', 'utf8');
  mkdirSync(join(dir, 'assets', 'concepts'), { recursive: true });
  mkdirSync(join(dir, 'assets', 'imported'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'concepts', 'cover.png'), 'COVER', 'utf8');
  writeFileSync(join(dir, 'assets', 'imported', 'old.png'), 'IMG', 'utf8');
  return dir;
};

test('scanStructure：根层书/文件 → books/；assets 旧目录 → 规范名 + 引用改写（README/assets/books 不动）', () => {
  const dir = mkStructuredWorld();
  try {
    const { items, moves } = scanStructure(dir);
    const movePairs = moves.filter((m) => m.kind === 'move').map((m) => `${m.from}→${m.to}`);
    assert.ok(movePairs.includes('黄金时代.md→books/黄金时代.md'), '配对 md');
    assert.ok(movePairs.includes('黄金时代→books/黄金时代'), '书目录');
    assert.ok(movePairs.includes('散记.md→books/散记.md'), '根层散文件');
    assert.ok(movePairs.includes('assets/concepts/cover.png→assets/covers/cover.png'), '封面规范名');
    assert.ok(movePairs.includes('assets/imported/old.png→assets/images/old.png'), '正文图规范名');
    assert.ok(!movePairs.some((x) => x.startsWith('README.md')), 'README 不动');
    const refs = moves.filter((m) => m.kind === 'ref');
    assert.equal(refs.length, 2, '&m 行与正文图各一行');
    assert.equal(refs[0].after, '&m assets/covers/cover.png');
    assert.equal(refs[1].after, '![图](assets/images/old.png)');
    assert.ok(items.some((it) => it.kind === 'move'), 'items 供工具箱展示');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('applyStructure：先改引用后搬运 → books/ 就位、assets 规范名、旧目录清空、备份留清单、防穿越', () => {
  const dir = mkStructuredWorld();
  try {
    const { moves } = scanStructure(dir);
    const evil = [{ kind: 'move', from: '../../etc/passwd', to: 'books/passwd' }];
    const r = applyStructure(dir, [...moves, ...evil]);
    assert.ok(r.moved >= 5, '至少 5 项搬移');
    assert.ok(existsSync(join(dir, 'books', '黄金时代.md')) && existsSync(join(dir, 'books', '黄金时代', '北伐.md')));
    assert.ok(existsSync(join(dir, 'books', '散记.md')));
    assert.ok(!existsSync(join(dir, '黄金时代')) && !existsSync(join(dir, '散记.md')), '根层已清空');
    assert.ok(existsSync(join(dir, 'assets', 'covers', 'cover.png')) && existsSync(join(dir, 'assets', 'images', 'old.png')));
    assert.ok(!existsSync(join(dir, 'assets', 'concepts')) && !existsSync(join(dir, 'assets', 'imported')), '旧资产目录清空移除');
    assert.ok(!existsSync(join(dir, 'books', 'passwd')), '穿越路径被跳过');
    const moved = readFileSync(join(dir, 'books', '散记.md'), 'utf8');
    assert.ok(moved.includes('&m assets/covers/cover.png') && moved.includes('![图](assets/images/old.png)'), '引用随文件搬到新位置（内容已改写）');
    const manifest = JSON.parse(readFileSync(join(dir, r.backup, 'structure-moves.json'), 'utf8'));
    assert.ok(manifest.moves.length >= 5, '移动清单入备份');
    // 迁移后再扫 → 干净
    assert.equal(scanStructure(dir).moves.length, 0, '迁移后零残留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lint：世界根非规范内容 → 结构提示行（第 89 轮）', () => {
  const dir = mkStructuredWorld();
  try {
    const items = lint(dir);
    const row = items.find((x) => x.kind === 'structure');
    assert.ok(row, '有结构提示');
    assert.match(row.message, /黄金时代|散记/);
    assert.match(row.message, /结构规范化/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
