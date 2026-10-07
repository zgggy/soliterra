// &元数据行值段语义（第 122 轮）——前后端同源单点真相：
//  ① 值可含空格，断于下一个 &关键字（&小写字母+空格/行尾）或行尾；
//  ② 双引号 "…" 整体包裹——**引号内的 &键 不作键**；未闭合引号按字面量；
//  ③ 仅 &t（标签）保留空白分词，其余键整段单值；
//  ④ 写出时值含 &键 序列/引号 → 自动补引号（读回无损）。
const LIST_KEYS = new Set(['t']);
const KEY_SRC = '&([a-z])(?=\\s|$)';

/** 平衡双引号区间（未闭合引号不成区间 → 按字面量）。 */
function quotedRanges(s) {
  const rs = [];
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue;
    if (start < 0) start = i;
    else { rs.push([start, i]); start = -1; }
  }
  return rs;
}

/** 引号感知的键位扫描：[{key, idx, valStart}]——引号内的 &键 跳过。 */
export function keyMatches(line) {
  const rs = quotedRanges(line);
  const re = new RegExp(KEY_SRC, 'g');
  const out = [];
  let m;
  while ((m = re.exec(line))) {
    if (rs.some(([a, b]) => m.index > a && m.index < b)) continue;
    out.push({ key: m[1], idx: m.index, valStart: m.index + m[0].length });
  }
  return out;
}

/** 值段 → 值数组（span 须来自 keyMatches 的相邻键位切片）。 */
export function parseValueSpan(span, key) {
  const s = span.trim();
  if (!s) return [];
  const list = LIST_KEYS.has(key);
  const out = [];
  let rest = s;
  while (rest.length) {
    if (rest.startsWith('"')) {
      const close = rest.indexOf('"', 1);
      if (close > 0) {
        out.push(rest.slice(1, close));
        rest = rest.slice(close + 1).trim();
        if (!list && rest) { out[0] = `${out[0]} ${rest}`; rest = ''; }
        continue;
      }
    }
    if (list) out.push(...rest.split(/\s+/).filter(Boolean));
    else out.push(rest);
    break;
  }
  return out;
}

/** 写出前的值整形：需要引号才不被误读的值 → 补引号（值内引号剥除——文件名本就禁 "）。 */
export function formatMetaValue(key, value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const need = /&[a-z](?=\s|$)/.test(v) || /^"/.test(v);
  const clean = v.replace(/"/g, '');
  return need ? `"${clean}"` : v;
}

/** 行级键改写：value 原值（内部 format）；value == null → 删键（连前导空白）。
 *  键不存在或该行非元数据行 → null。 */
export function replaceKeyInLine(line, key, value) {
  if (!/^\s*&[a-z]/.test(line)) return null;
  const ms = keyMatches(line);
  const i = ms.findIndex((x) => x.key === key);
  if (i < 0) return null;
  if (value == null || String(value).trim() === '') {
    let from = ms[i].idx;
    while (from > 0 && (line[from - 1] === ' ' || line[from - 1] === '\t')) from--;
    const to = i + 1 < ms.length ? ms[i + 1].idx : line.length;
    return (line.slice(0, from) + line.slice(to)).replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
  }
  const fmt = formatMetaValue(key, value);
  const valStart = ms[i].valStart;
  const end = i + 1 < ms.length ? ms[i + 1].idx : line.length;
  const sep = i + 1 < ms.length ? ' ' : '';
  return (line.slice(0, valStart) + ' ' + fmt + sep + line.slice(end)).replace(/[ \t]{2,}/g, ' ');
}

/** 文本级设键（第 122 轮统一）：值空 = 删键（逐行）；已有键 = 值段改写保同键其余段；无键 = 插入文档头。
 *  vault.setMetaLine 与前端元数据抽屉 applyMetaToText 原是两份同函数——自此同源。 */
export function setMetaText(text, key, value) {
  if (value == null || String(value).trim() === '') {
    const re = new RegExp(`(^|\\s)&${key}(?=\\s|$)`);
    const out = [];
    for (const line of String(text).split('\n')) {
      if (!re.test(line)) { out.push(line); continue; }
      const nl = (replaceKeyInLine(line, key, null) ?? line.replace(re, '$1'))
        .replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
      if (nl.trim() === '' || nl.trim() === '&') continue;   // 行里没别的键了 → 删行
      out.push(nl);
    }
    return out.join('\n');
  }
  const nt = replaceKeyInText(text, key, value);
  if (nt !== null) return nt;
  return `&${key} ${formatMetaValue(key, value)}\n` + String(text);
}

/** 文本级键改写：首个含该键的**元数据行**（行首为 &键）内改写；键不存在 → null（调用方决定是否插入）。 */
export function replaceKeyInText(text, key, value) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const nl = replaceKeyInLine(lines[i], key, value);
    if (nl !== null) { lines[i] = nl; return lines.join('\n'); }
  }
  return null;
}
