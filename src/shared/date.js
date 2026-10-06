// Soliterra 日期值规范化（第 95 轮，纯函数单点真相）——元数据编辑卡确认时把各种写法归一为 `yyyy.mm.dd`。
// 接受（月份/日期自动补足两位、年份补足四位；`*` 模糊段保留）：
//   `705.9.10` `705/9/10` `705-9-10` `705:9:10` `0705.9.10` `0705.*.*` → `0705.09.10` / `0705.*.*`
//   两段 `0705.9` `705/9` → `0705.09.*.*`（缺月补 * 、缺日补 *）
//   中文 `705年9月10日` `705年9月` `705年` → `0705.09.10` 等
//   前纪 `前300` `公元前300年` `-300` `-0300.01.01` → `-0300.*.*` / `-0300.01.01`
//   仅年 `705` → `0705.*.*`
// 返回 null = 无法识别（编辑卡据此阻止确认并提示）；'' 原样返回（删键）。

const pad4 = (y) => String(y).padStart(4, '0');
const pad2 = (v) => String(v).padStart(2, '0');
const fmt = (neg, y, mo, d) => `${neg ? '-' : ''}${pad4(y)}.${mo === '*' ? '*' : pad2(mo)}.${d === '*' ? '*' : pad2(d)}`;

export function normalizeDateValue(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  // ── 前纪：中文「前X年 / 公元前X年」与 `-X` 前缀（统一剥出符号，剩余部分按正年解析）──
  let neg = false;
  const preCn = v.match(/^(?:公元前)?前\s*(\d{1,4})\s*年?$/) || v.match(/^公元前\s*(\d{1,4})\s*年?$/);
  if (preCn) { neg = true; v = preCn[1]; }
  else if (v.startsWith('-')) { neg = true; v = v.slice(1).trim(); }
  else if (/^公元前/.test(v)) { neg = true; v = v.replace(/^公元前/, '').trim(); }
  else if (/^前(?=\d)/.test(v)) { neg = true; v = v.replace(/^前/, ''); }

  // ── 中文日期：Y年M月D日 / Y年M月 / Y年 ──
  let m = v.match(/^(\d{1,4})\s*年\s*(\d{1,2}|\*)\s*月\s*(\d{1,2}|\*)\s*日?$/);
  if (m) return fmt(neg, m[1], m[2], m[3]);
  m = v.match(/^(\d{1,4})\s*年\s*(\d{1,2}|\*)\s*月$/);
  if (m) return fmt(neg, m[1], m[2], '*');
  m = v.match(/^(\d{1,4})\s*年$/);
  if (m) return fmt(neg, m[1], '*', '*');

  // ── 数字三段：Y.M.D（分隔 . / - : 混用皆可；M/D 为 * 或 1–2 位）──
  m = v.match(/^(\d{1,4})\s*[.\/\-:]\s*(\d{1,2}|\*)\s*[.\/\-:]\s*(\d{1,2}|\*)$/);
  if (m) return fmt(neg, m[1], m[2], m[3]);

  // ── 两段：Y.M → 日补 *；仅年 → 月日补 * ──
  m = v.match(/^(\d{1,4})\s*[.\/\-]\s*(\d{1,2}|\*)$/);
  if (m) return fmt(neg, m[1], m[2], '*');
  m = v.match(/^(\d{1,4})$/);
  if (m) return fmt(neg, m[1], '*', '*');

  return null;   // 识别失败
}
