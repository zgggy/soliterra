// 编辑器行内标记折叠（功能设计 §B.3.1）：纯函数、零依赖——「改显示不改字节」。
// 规则：**成对才藏**（不成对原样保留）；`&` 行、围栏行、fence 区间、光标行、选区覆盖由**调用侧**豁免。

/**
 * 行内可折叠标记 → 零宽隐藏区间列表 [start, end)（行内偏移，可直接 Decoration.replace({})）。
 * 覆盖：行首 `#{1,6}` 数量符 · `**粗**` 双星 · `*斜*` 单星 · `` `码` `` 反引号 · `[[双链|别名]]` 两对括号。
 */
export function foldMarks(text) {
  const t = String(text ?? '');
  const folds = [];
  // 行首 # 数量符（语法高亮 cm-h1/h2/h3 由 syntax token 提供 → 折叠后显示为顶格的"无 # 标题"）
  // 数量符连后随的单个空格一并藏（只藏 # 会留下难看的前导空格）
  const hm = /^(#{1,6})(\s)/.exec(t);
  if (hm) folds.push([0, hm[1].length + 1]);
  // 成对标记：开标记 [i, i+openLen)、闭标记 [i+len-closeLen, i+len)
  const pair = (re, openLen, closeLen) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      if (m[0].length < openLen + closeLen + 1) continue;   // 内容至少 1 字符
      folds.push([m.index, m.index + openLen]);
      folds.push([m.index + m[0].length - closeLen, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  pair(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, 2, 2);                      // **粗**（非贪婪+嵌套感知：内容允许单星如 *内*；只藏两端星、内容区间不入 folds）
  pair(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, 1, 1);                          // *斜*（防 *** 与粗体内嵌）
  pair(/`([^`\n]+)`/g, 1, 1);                                        // `码`
  pair(/\[\[([^\]\n]*)\]\]/g, 2, 2);                                 // [[…]] 只藏括号（内容与 |别名 保留）
  return folds.sort((a, b) => a[0] - b[0]);
}
