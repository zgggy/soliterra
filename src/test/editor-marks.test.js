// 第 85 轮：编辑器行内标记折叠（§B.3.1 纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldMarks } from '../editor/editor-marks.js';

const fold = (text, folds) => {
  let out = '';
  let last = 0;
  for (const [a, b] of folds) { out += text.slice(last, a); last = b; }
  return out + text.slice(last);
};

test('foldMarks：成对标记全藏（** * ` [[ ]] #）', () => {
  const f1 = foldMarks('**粗体**文本');
  assert.equal(fold('**粗体**文本', f1), '粗体文本');
  const f2 = foldMarks('*斜体*文本');
  assert.equal(fold('*斜体*文本', f2), '斜体文本');
  const f3 = foldMarks('看 `code` 内');
  assert.equal(fold('看 `code` 内', f3), '看 code 内');
  const f4 = foldMarks('链到 [[目标|别名]] 结束');
  assert.equal(fold('链到 [[目标|别名]] 结束', f4), '链到 目标|别名 结束');
  const f5 = foldMarks('## 二级标题');
  assert.equal(fold('## 二级标题', f5), '二级标题');
});

test('foldMarks：不成对不藏（防半截折叠）', () => {
  assert.equal(foldMarks('孤立的 ** 星号').length, 0, '单个 ** 不藏');
  assert.equal(foldMarks('a ** b').length, 0);
  assert.equal(foldMarks('半边 [[链').length, 0);
  assert.equal(foldMarks('没有标记').length, 0);
});

test('foldMarks：混合与边界（粗体内单星不误伤、行中 # 不藏、多对标记）', () => {
  const t = '**粗 *内* 细** 与 `码` 与 [[链]]';
  assert.equal(fold(t, foldMarks(t)), '粗 内 细 与 码 与 链', '粗体内合法嵌套斜体 *内* 同样折叠（markdown 语义一致；字节不动）');
  assert.equal(foldMarks('文中 # 井号').length, 0, '非行首 # 不藏');
  assert.equal(foldMarks('# #').length, 1, '行首 # 数量符藏（含后随空格）');
  const multi = foldMarks('`a` 和 `b`');
  assert.equal(fold('`a` 和 `b`', multi), 'a 和 b');
});

test('foldMarks：返回区间已排序且互不相交（RangeSetBuilder 前置条件）', () => {
  const f = foldMarks('## **粗** `码` [[链]] *斜*');
  for (let i = 1; i < f.length; i++) assert.ok(f[i][0] >= f[i - 1][1], `区间 ${i} 与前一个相交或乱序`);
});
