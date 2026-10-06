// 第 83 轮：EPUB 封面嵌入（zip STORED 不压缩 → 内容明文可扫）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEpub, buildDocx } from '../public/js/exporter.js';

const chapters = [{ title: '章一', html: '<p>正文</p>' }];

async function zipText(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('latin1');   // 结构 ASCII 断言（一对一不吞字节）
}
async function zipUtf8(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('utf8');     // 中文内容断言
}

test('buildEpub：无封面 = 原行为（无 cover 条目）', async () => {
  const zip = await zipText(buildEpub({ title: '书', chapters }));
  assert.ok(zip.includes('OEBPS/content.opf'));
  assert.ok(!zip.includes('cover-img'), '无封面不出现 cover-img');
});

test('buildEpub：封面嵌入 —— 文件入 zip + opf manifest properties=cover-image + meta name=cover', async () => {
  const cover = { name: 'cover.png', bytes: new Uint8Array([137, 80, 78, 71]) };
  const zip = await zipText(buildEpub({ title: '书', chapters, cover }));
  assert.ok(zip.includes('OEBPS/cover.png'), '封面文件入包');
  assert.ok(zip.includes('id="cover-img"'), 'manifest 有 cover-img');
  assert.ok(zip.includes('properties="cover-image"'), 'cover-image property');
  assert.ok(zip.includes('image/png'), 'media-type 正确');
  assert.ok(zip.includes('<meta name="cover" content="cover-img"/>'), 'opf meta cover 指向');
});

test('buildDocx：最小 OOXML 包（document.xml 明文）+ 标题字号直写 + 元数据行剔除 + 行内格式', async () => {
  const chapters = [
    '&s 0500.01.01\n&n X\n\n# 章一 标题\n\n正文 **粗** 与 [[别名|显示]]。\n\n```event\nkind: demo\n```\n\n- 列表项\n',
    '## 二级\n\n> 引用行\n',
  ];
  const blob = buildDocx({ title: '测试书', chapters });
  const zip = await zipText(blob);
  assert.ok(zip.includes('word/document.xml'), '三件套在包');
  assert.ok(zip.includes('[Content_Types].xml') && zip.includes('_rels/.rels'));
  const doc = await zipUtf8(blob);   // STORED 不压缩 → UTF-8 明文可扫（中文断言用 utf8 解码）
  assert.ok(doc.includes('测试书'), '书名入文档');
  assert.ok(doc.includes('章一 标题') && doc.includes('<w:b/>'), 'H1 粗体');
  assert.ok(doc.includes('<w:sz w:val="28"/>'), 'H2 字号直写（无需 styles.xml）');
  assert.ok(!doc.includes('0500.01.01'), '元数据行已剔除');
  assert.ok(!doc.includes('&amp;s'), '（转义后也不残留）');
  assert.ok(doc.includes('显示'), '双链取别名显示');
  assert.ok(doc.includes('kind: demo'), '围栏内容保留（标记行跳过）');
  assert.ok(doc.includes('· 列表项'), '列表项加点前缀');
  assert.ok(doc.includes('引用行'), '引用成段');
});
