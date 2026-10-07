// 第 86 轮：深层 YAML frontmatter 兼容读取（§15.6）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, splitFrontmatter, KEYS, parseMetadataLine, entryTitle, formatMetaValue, replaceKeyInLine } from '../lib/parser.js';
import { entryMetaParts } from '../lib/render.js';

test('splitFrontmatter：文件头块剥离 + 至少一行 key: 才认定', () => {
  const fm = '---\ntitle: 章名\ntags: [a, b]\nstatus: canon\nsub:\n  nested: v\n---\n# 正文\n';
  const r = splitFrontmatter(fm);
  assert.ok(r.fm, '块被识别');
  assert.equal(r.fm.title, '章名');
  assert.deepEqual(r.fm.tags, ['a', 'b']);
  assert.deepEqual(r.fm.sub, [], '空值键/嵌套块安全忽略（块已剥、文件不动）');
  assert.ok(r.body.startsWith('# 正文'), '正文从标题起');
  // 文中 --- 分割线不误剥
  const doc = '前文\n\n---\n\n后文\n';
  const r2 = splitFrontmatter(doc);
  assert.equal(r2.fm, null, '非键值块不剥');
  assert.equal(r2.body, doc, '原文原样');
  // 引号值 / 块数组
  const r3 = splitFrontmatter("---\ntitle: \"引号名\"\nitems:\n  - 一\n  - 二\n---\nx\n");
  assert.equal(r3.fm.title, '引号名');
  assert.deepEqual(r3.fm.items, ['一', '二']);
});

test('parseEntry：三键映射（& 行优先）+ 正文不含 YAML', () => {
  const text = '---\ntitle: YAML名\ntags: [甲, 乙]\nstatus: draft\n---\n&n 优先名\n&s 0800.01.01\n\n# 标题\n\n正文。\n';
  const e = parseEntry('a.md', text);
  assert.equal(e.meta.n[0], '优先名', '&n 不被 title 覆盖');
  assert.deepEqual(e.meta.t, ['甲', '乙'], 'tags → &t（无 &t 时）');
  assert.equal(e.meta.p[0], 'draft', 'status → &p');
  assert.equal(e.meta.s[0], '0800.01.01', '&s 正常解析');
  assert.ok(!e.body.includes('title:'), 'body 不含 YAML');
  assert.ok(!e.body.includes('---'), 'body 不含 frontmatter 分隔');
  // 无 fm 文档不受影响
  const plain = parseEntry('b.md', '# 普通\n\n---\n\n分割线后。\n');
  assert.equal(plain.title, '普通');
  assert.ok(plain.body.includes('分割线后。'));
});

// 第 91 轮：&r 同层目录顺序键
test('parseEntry：&r 顺序键解析 + KEYS 登记（lint 不报未知键）', () => {
  const e = parseEntry('a.md', '&r 2\n&s 0700.01.01\n\n# 标题\n\n正文。\n');
  assert.deepEqual(e.meta.r, ['2']);
  assert.ok(KEYS.includes('r'), 'r 在键表中');
  // 同行多键：&r 原位改值时不得吞掉同行的其他键（vault.setOrder 依赖此行形态）
  const mixed = parseEntry('b.md', '&r 9 &t 设定\n\n# 标题\n');
  assert.deepEqual(mixed.meta.r, ['9']);
  assert.deepEqual(mixed.meta.t, ['设定']);
});

// 第 113 轮：in-world 作者（&w）与作成时间（&d）——标题右侧展示
test('parseEntry + entryMetaParts：&w/&d 解析并合入标题右侧 aside', () => {
  const e = parseEntry('w.md', '&n 某书 &w 星辉史官 &d 0705.09\n\n# 某书\n\n正文\n');
  assert.deepEqual(e.meta.w, ['星辉史官']);
  assert.deepEqual(e.meta.d, ['0705.09']);
  assert.ok(KEYS.includes('w') && KEYS.includes('d'), '键表登记（lint 不报未知）');
  const { rangeHTML } = entryMetaParts(e.meta, 'zh-CN');
  assert.ok(rangeHTML.includes('entry-aside'), '合入标题右侧容器');
  assert.ok(rangeHTML.includes('作者 · 星辉史官'), '作者项');
  assert.ok(rangeHTML.includes('成书 · 0705.09'), '作成时间项');
  const en = entryMetaParts(e.meta, 'en');
  assert.ok(en.rangeHTML.includes('Author ·') && en.rangeHTML.includes('Written ·'), 'en 文案');
  // 无 &w/&d 且无 &s → aside 空（不占位）
  const bare = entryMetaParts({}, 'zh-CN');
  assert.equal(bare.rangeHTML, '', '无值不渲染');
});

test('parseMetadataLine：值可含空格（断于下一 &键）+ 双引号包裹（第 122 轮）', () => {
  // 未引号：整段单值，仅断于下一个 &关键字；中间空格全属值
  const r = parseMetadataLine('&n 我的 条目 &t 设定 历史');
  assert.deepEqual(r.find((x) => x.key === 'n').values, ['我的 条目'], '&n 空格整段单值');
  assert.deepEqual(r.find((x) => x.key === 't').values, ['设定', '历史'], '&t 仍空白分词（标签列表）');
  // 双引号：内含空格与 & 键符也整体成值
  const q = parseMetadataLine('&n "带 &钩的 名字"');
  assert.deepEqual(q[0].values, ['带 &钩的 名字'], '双引号内原样（含 & 与空格）');
  const q2 = parseMetadataLine('&t "多词 标签" 单词');
  assert.deepEqual(q2[0].values, ['多词 标签', '单词'], '列表键：引号元素整体 + 裸词分词');
  // & 后不是键（空格/大写）→ 不断值
  assert.deepEqual(parseMetadataLine('&n A & B')[0].values, ['A & B'], '& 后空格不是键');
  assert.deepEqual(parseMetadataLine('&n R&D 实验 &e 0705.01.01')[0].values, ['R&D 实验'], '大写 &D 不是键；&e 正常断值');
  // 行内非首键也按值段收
  const multi = parseMetadataLine('&w 张 三 &d 0705.09.09');
  assert.deepEqual(multi.find((x) => x.key === 'w').values, ['张 三'], '&w 含空格');
  assert.deepEqual(multi.find((x) => x.key === 'd').values, ['0705.09.09'], '&d 正常');
});

test('entryTitle：&n 空格名整段为标题（第 122 轮）', () => {
  const e = parseEntry('x.md', '&n 带 空格 的 标题 &t a b\n\n# 别的\n\n正文\n');
  assert.equal(e.title, '带 空格 的 标题', '空格不断标题');
  assert.deepEqual(e.meta.t, ['a', 'b'], '标签照旧分词');
  assert.equal(entryTitle({ n: ['空 格 名'] }, '# 兜底\n', 'f.md'), '空 格 名', 'entryTitle 直通');
});

test('引号内 &键 不作键 + 写出整形回环（第 122 轮）', () => {
  const r = parseMetadataLine('&n "鱼 &t 池" &s 0705.01.01');
  assert.deepEqual(r.find((x) => x.key === 'n').values, ['鱼 &t 池'], '引号内 &t 不断键/不拆值');
  assert.deepEqual(r.find((x) => x.key === 's').values, ['0705.01.01'], '引号外键照常解析');
  assert.equal(formatMetaValue('n', 'A &t B'), '"A &t B"', '值含键序列 → 自动补引号');
  assert.equal(formatMetaValue('n', '鱼 & 熊掌'), '鱼 & 熊掌', '非键 & 不加引号');
  assert.equal(formatMetaValue('n', '普通名'), '普通名', '无需引号原样');
  const line = replaceKeyInLine('&n 旧 名 &t 设定', 'n', '新 &t 名');
  assert.equal(line, '&n "新 &t 名" &t 设定', '行级改写：自动引号 + 同键其余段保留');
  assert.deepEqual(parseMetadataLine(line).find((x) => x.key === 'n').values, ['新 &t 名'], '改写后读回一致');
  assert.equal(replaceKeyInLine('正文里 &n x', 'n', 'y'), null, '非元数据行不动');
});
