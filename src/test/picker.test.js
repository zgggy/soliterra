// 原生选择器纯函数测试（第 88 轮）：取消判定 + 路径归一。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCancelError, normalizePicked } from '../lib/picker.js';

test('normalizePicked：去空白与目录尾斜杠', () => {
  assert.equal(normalizePicked('/Users/zgy/SoliterraWorlds/卡纳利斯/\n'), '/Users/zgy/SoliterraWorlds/卡纳利斯');
  assert.equal(normalizePicked('/tmp/x.png\n'), '/tmp/x.png');
  assert.equal(normalizePicked('  /tmp/a  '), '/tmp/a');
  assert.equal(normalizePicked(''), '');
});

test('isCancelError：-128 与 User canceled 判定（其余错误不吞）', () => {
  assert.equal(isCancelError({ stderr: 'execution error: User canceled. (-128)' }), true);
  assert.equal(isCancelError({ message: 'Command failed: osascript -e ...' }), false);
  assert.equal(isCancelError({ stderr: 'execution error: 不能把世界库本身作为世界 (-2700)' }), false);
  assert.equal(isCancelError(null), false);
});
