// 第 86 轮：深层 YAML frontmatter 兼容读取（§15.6）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, splitFrontmatter, KEYS } from '../lib/parser.js';

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
