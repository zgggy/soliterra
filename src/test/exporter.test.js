// 第 83 轮：EPUB 封面嵌入（zip STORED 不压缩 → 内容明文可扫）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEpub } from '../public/js/exporter.js';

const chapters = [{ title: '章一', html: '<p>正文</p>' }];

async function zipText(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('latin1');
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
