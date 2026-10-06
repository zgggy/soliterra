// 第 83 轮：只读站点发布测试（链接改写 / 可见性三处防泄漏 / 深度相对 / 图片复制 / 元数据 span 化）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, isPublished } from '../lib/publish.js';

const mkWorld = () => {
  const root = mkdtempSync(join(tmpdir(), 'soliterra-site-'));
  const w = join(root, '测试世界');
  mkdirSync(join(w, 'assets'), { recursive: true });
  writeFileSync(join(w, 'assets', 'pic.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'utf8');
  writeFileSync(join(w, 'A.md'),
    '&s 0500.01.01\n\n# A 甲条目\n\n见 [[B]] 与 [[C|丙]]。嵌入：\n\n![[C]]\n\n隐藏嵌入：\n\n![[B]]\n', 'utf8');
  writeFileSync(join(w, 'B.md'), '&v 作者\n\n# B 作者私货\n\n不能出现在站点里。\n', 'utf8');
  writeFileSync(join(w, 'C.md'), '# C 丙条目\n\n图片 ![图](assets/pic.png)\n\n回链 [[dir/d|深层]]。\n', 'utf8');
  mkdirSync(join(w, 'dir'), { recursive: true });
  writeFileSync(join(w, 'dir', 'd.md'), '# D 深层\n\n回 [[A]]。\n', 'utf8');
  mkdirSync(join(w, 'book'), { recursive: true });
  writeFileSync(join(w, 'book.md'), '&t 书籍\n\n# 书\n', 'utf8');
  writeFileSync(join(w, 'book', 'ch1.md'), '# 章一\n', 'utf8');
  return { root, w };
};

test('isPublished：&v 作者不发布（visibility=all 全含）', () => {
  assert.equal(isPublished({ v: ['作者'] }), false);
  assert.equal(isPublished({ v: ['作者'] }, 'all'), true);
  assert.equal(isPublished({ v: ['秘传'] }), true);
  assert.equal(isPublished({}), true);
});

test('buildSite：页面集合 + 可见性三处防泄漏（无页面/无 href/嵌入退回）', () => {
  const { root, w } = mkWorld();
  try {
    const r = buildSite(w);
    assert.equal(r.hidden, 1, 'B（&v 作者）被隐藏');
    assert.ok(existsSync(join(r.dir, 'index.html')));
    assert.ok(existsSync(join(r.dir, 'A.html')));
    assert.ok(existsSync(join(r.dir, 'dir', 'd.html')), '路径镜像保留目录');
    assert.ok(!existsSync(join(r.dir, 'B.html')), '隐藏条目不生成页');
    const a = readFileSync(join(r.dir, 'A.html'), 'utf8');
    assert.ok(!a.includes('作者私货'), '正文不泄漏');
    assert.ok(!/href="B\.html"/.test(a), '指向隐藏条目的 wikilink 不出 href');
    assert.ok(!/<a[^>]*href="B\.html"/.test(a));
    assert.match(a, /<a class="wikilink" data-target="B"/, '但链接样式保留（不可点）');
    assert.match(a, /href="C\.html"/, '同目录目标出 href');
    assert.match(a, /data-target="C"/, '别名 [[C|丙]] 的目标是 C');
    assert.match(a, />丙<\/a>/, '别名显示文本为丙');
    assert.match(a, /丙条目/, '![[C]] 嵌入内容渲染进正文（深度 1 resolver）');
    // 元数据按钮 span 化
    assert.match(a, /<span class="m-item m-s">0500\.01\.01<\/span>/, 'm-item button → span');
    assert.ok(!/<button class="m-item/.test(a), '不再有元数据 button');
    // 目录树
    const idx = readFileSync(join(r.dir, 'index.html'), 'utf8');
    assert.ok(!idx.includes('作者私货') && !/>B 作者私货</.test(idx), '目录树不含隐藏条目');
    assert.match(idx, /href="C\.html"/, '树链接正确');
    assert.match(idx, /<a href="book\.html">书<\/a>/, '配对目录（book.md + book/）合并为可点节点');
    // 深度相对
    const d = readFileSync(join(r.dir, 'dir', 'd.html'), 'utf8');
    assert.match(d, /href="\.\.\/A\.html"/, '跨目录回链按深度算 ../');
    assert.match(d, /href="\.\.\/style\.css"/, '样式按深度相对');
    // 图片：根页 src 不变并复制
    const c = readFileSync(join(r.dir, 'C.html'), 'utf8');
    assert.match(c, /src="assets\/pic\.png"/);
    assert.ok(existsSync(join(r.dir, 'assets', 'pic.png')), '图片已复制进站点');
    // style.css = app.css 复制 + 站点段
    const css = readFileSync(join(r.dir, 'style.css'), 'utf8');
    assert.match(css, /\.event-flag/, 'app.css 特征在');
    assert.match(css, /只读站点/, '站点专用段在');
    assert.ok(r.pages >= 5, `页数 ${r.pages}（A/C/d/book章 + index）`);
    // 图片被引用（C 是根页）
    assert.equal(r.assets, 1, 'assets 计数 = pic.png');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildSite visibility=all：隐藏条目恢复发布', () => {
  const { root, w } = mkWorld();
  try {
    const r = buildSite(w, { visibility: 'all' });
    assert.equal(r.hidden, 0);
    assert.ok(existsSync(join(r.dir, 'B.html')), 'all 模式下 B 生成');
    assert.match(readFileSync(join(r.dir, 'A.html'), 'utf8'), /href="B\.html"/, 'all 模式下链接可用');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
