// 第 78 轮：工具库测试（备份剪枝 + apply 端到端）。临时目录操作，零外依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, pruneBackups, lint } from '../lib/tools.js';

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
