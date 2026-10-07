// Soliterra 工具箱（功能设计 §12）——扫描 → diff 预览 → 批量应用（备份 + git 提交）。
// 首批：① 日期时间规范化（yyyy.mm.dd / hh:mm:ss，缺段补 *）② 【【】】→[[]]

import fs from 'node:fs';
import path from 'node:path';
import { collectMarkdown } from './indexer.js';
import { parseEntry, parseMetadataLine, parseDate, extractFences, KEYS } from './parser.js';
import { replaceKeyInLine } from '../shared/meta.js';
import { containsSymbol, normalizeSymbols } from '../shared/symbols.js';

// ---------- 规则 ----------

/** 日期：705.9.10→0705.09.10；705/9/10、705-9-10 同理；705.9→0705.09.*（第 95 轮修：曾误补成四段 0705.09.*.*，parseDate/lint 三段不认）；705年9月10日→0705.09.10 */
function normalizeDatesInLine(line) {
  let out = line;
  // 中文式：0705年09月10日 / 705年9月10日
  out = out.replace(/(\d{1,4})年(\d{1,2})月(\d{1,2})日/g,
    (_, y, m, d) => `${padYear(y)}.${pad2(m)}.${pad2(d)}`);
  // 数字式：三段（含 * 模糊段）
  out = out.replace(/(?<![\d.\-*])(\d{1,4})[.\/\-](\d{1,2}|\*)[.\/\-](\d{1,2}|\*)(?![\d])/g,
    (whole, y, m, d) => {
      const norm = `${padYear(y)}.${m === '*' ? '*' : pad2(m)}.${d === '*' ? '*' : pad2(d)}`;
      return norm === whole ? whole : norm;
    });
  // 数字式：两段（年.月）→ 补 *.*（仅当出现在 & 元数据行时由调用方限定）
  return out;
}

/** 时间：9:5:3→09:05:03；14:05→14:05:00 */
function normalizeTimesInLine(line) {
  return line.replace(/(?<![\d:])(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?![\d])/g,
    (whole, h, m, s) => {
      const norm = `${pad2(h)}:${pad2(m)}:${s === undefined ? '00' : pad2(s)}`;
      return norm === whole ? whole : norm;
    });
}

/** &s/&e 值里的「前300」→「-0300.*.*」；两段日期补 * */
function normalizeMetaRange(line) {
  let out = line;
  out = out.replace(/&([se])\s+前(\d{1,4})(?=\s|&|$)/g, (_, k, y) => `&${k} -${padYear(y)}.*.*`);
  // &s/&e 后的值若为「年.月」两段 → yyyy.mm.*（三段；第 95 轮修：原 `.*.*` 是四段违规值）
  out = out.replace(/&([se])\s+(-?\d{1,4})\.(\d{1,2}|\*)(?=\s|&|$)/g,
    (_, k, y, m) => {
      const yy = y.startsWith('-') ? '-' + padYear(y.slice(1)) : padYear(y);
      return `&${k} ${yy}.${m === '*' ? '*' : pad2(m)}.*`;
    });
  return out;
}

function pad2(v) { return String(v).padStart(2, '0'); }
function padYear(v) { return String(v).padStart(4, '0'); }

/** 括号转双链：【【X】】→[[X]]；兼容〔〔〕〕、〖〖〗〗 */
function normalizeBracketsInLine(line) {
  return line
    .replace(/【【(.+?)】】/g, '[[$1]]')
    .replace(/〔〔(.+?)〕〕/g, '[[$1]]')
    .replace(/〖〖(.+?)〗〗/g, '[[$1]]');
}

/** 对一行应用某工具，返回新行（无变化时返回原行）。 */
export function transformLine(tool, line) {
  if (tool === 'date') {
    let out = normalizeDatesInLine(line);
    out = normalizeTimesInLine(out);
    if (/^\s*&/.test(out) || /&[se]\s/.test(out)) out = normalizeMetaRange(out);
    return out;
  }
  if (tool === 'brackets') return normalizeBracketsInLine(line);
  return line;
}

// ---------- 扫描与批处理 ----------

/** 扫描：返回 [{path, line, before, after}] */
export function scan(worldDir, tool, limit = 500) {
  const out = [];
  for (const rel of collectMarkdown(worldDir)) {
    let text;
    try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const after = transformLine(tool, lines[i]);
      if (after !== lines[i]) {
        out.push({ path: rel, line: i + 1, before: lines[i], after });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// ---------- 补充工具（2026-10-06）：拼写漂移 / 图片路径规范化 / 全库正则替换 ----------

/** 编辑距离（≤2 才关心；对小串直接 DP）。 */
function dist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** 拼写漂移：悬空双链的目标与既有条目名「近似」（编辑距离 ≤2）→ 逐处替换为目标正名。 */
export function scanDrift(worldDir, limit = 500) {
  const entries = [];
  for (const rel of collectMarkdown(worldDir)) {
    let text; try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    entries.push({ rel, text, e: parseEntry(rel, text) });
  }
  const titles = [...new Set(entries.map((x) => x.e.title).filter(Boolean))];
  const titleSet = new Set(titles);
  const out = [];
  const LINK_RE = /\[\[([^\]|#]+)((?:[|#][^\]]*)?)\]\]/g;
  for (const { rel, text } of entries) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let hit = false;
      const after = lines[i].replace(LINK_RE, (whole, target, rest) => {
        const t = target.trim();
        if (!t || titleSet.has(t)) return whole;
        let best = null, bestD = 3;
        for (const cand of titles) {
          const d = dist(t, cand);
          if (d < bestD) { bestD = d; best = cand; }
        }
        if (best == null || bestD > 2) return whole;
        hit = true;
        return `[[${best}${rest}]]`;
      });
      if (hit) { out.push({ path: rel, line: i + 1, before: lines[i], after }); if (out.length >= limit) return out; }
    }
  }
  return out;
}

// ---------- 符号规范化（第 93 轮）：全角 ASCII 标点 / 弯引号 → 半角 ----------
// 表见 shared/symbols.js（单点真相）：[[别名｜]]、![]（...）、& 行值里的全角符号是常见误用；
// 「」『』（）与中文句读保留（不入表，扫描不报）。
export function scanSymbols(worldDir, limit = 500) {
  const out = [];
  for (const rel of collectMarkdown(worldDir)) {
    let text; try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!containsSymbol(lines[i])) continue;
      const after = normalizeSymbols(lines[i]);
      if (after !== lines[i]) { out.push({ path: rel, line: i + 1, before: lines[i], after }); if (out.length >= limit) return out; }
    }
  }
  return out;
}

// ---------- 封面规范（第 114 轮）：命名重命名修复 + 孤儿检查 ----------
/** ① &m 指向 covers/ 但文件名 ≠ 条目名（README = 世界名）→ 重命名修复行（带 rename 联动）；
 *  ② covers/ 中未被任何 &m 引用的孤儿文件 → manual 提示行（不可自动修，需人工确认删除）。 */
export function scanCover(worldDir, limit = 500) {
  const items = [];
  const coversAbs = path.join(worldDir, 'assets', 'covers');
  const files = [];
  try {
    for (const nm of fs.readdirSync(coversAbs)) {
      if (fs.statSync(path.join(coversAbs, nm)).isFile()) files.push(nm);
    }
  } catch { /* 无 covers 目录 */ }
  const used = new Set();
  for (const rel of collectMarkdown(worldDir)) {
    let text; try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const m = parseEntry(rel, text).meta?.m?.[0];
    if (!m || !m.startsWith('assets/covers/')) continue;
    used.add(m);
    const curName = path.basename(m);
    const base = path.basename(rel).replace(/\.md$/i, '');
    const entry = base === 'README' ? path.basename(worldDir) : base;   // README → 世界名
    const ext = path.extname(curName) || '.png';
    const wantName = `${entry}${ext}`;
    if (curName === wantName) continue;                                 // 已规范
    let to = `assets/covers/${wantName}`;
    let n = 1;
    while (files.includes(path.basename(to)) && to !== m) {             // 目标被占 → 序号（防重名）
      to = `assets/covers/${entry}-${n++}${ext}`;
    }
    if (to === m) continue;
    // before/after 必须是**含 &m 的整行**（&m 常与 &n 同行——apply 按整行匹配，片段永不命中）
    const lines = text.split('\n');
    const lineIdx = lines.findIndex((l) => /(^|\s)&m\s+\S/.test(l));
    if (lineIdx < 0) continue;
    const line = lines[lineIdx];
    const afterLine = replaceKeyInLine(line, 'm', to) ?? line;   // 第 122 轮：值段改写（路径可含空格）保同键
    if (afterLine === line) continue;
    items.push({ kind: 'cover', path: rel, line: lineIdx + 1, before: line, after: afterLine, rename: { from: m, to } });
    if (items.length >= limit) return items;
  }
  for (const nm of files) {                                              // ② 孤儿
    const rel2 = `assets/covers/${nm}`;
    if (!used.has(rel2)) items.push({ manual: true, path: rel2, line: 0, before: `孤儿封面（未被任何 &m 引用）：${nm}` });
  }
  return items.slice(0, limit);
}

/** 图片路径规范化：绝对路径 / file:// → 相对 assets/。 */
export function scanImages(worldDir, limit = 500) {
  const out = [];
  const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
  for (const rel of collectMarkdown(worldDir)) {
    let text; try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let hit = false;
      const after = lines[i].replace(IMG_RE, (whole, alt, src) => {
        const s2 = src.trim();
        if (s2.startsWith('assets/') || s2.startsWith('./assets/')) return whole;
        const idx = s2.replace(/\\/g, '/').indexOf('/assets/');
        const tail = idx >= 0 ? s2.replace(/\\/g, '/').slice(idx + 1)
          : (/^(\/|[a-zA-Z]:)/.test(s2) ? null : whole);
        if (!tail || tail === s2) return whole;
        hit = true;
        return `![${alt}](${tail})`;
      });
      if (hit) { out.push({ path: rel, line: i + 1, before: lines[i], after }); if (out.length >= limit) return out; }
    }
  }
  return out;
}

/** 全库正则替换：pattern → replacement（g 标志；非法正则抛错由 API 转 400）。 */
export function scanRegex(worldDir, pattern, replacement, limit = 500) {
  const re = new RegExp(pattern, 'g');
  const out = [];
  for (const rel of collectMarkdown(worldDir)) {
    let text; try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const after = lines[i].replace(re, replacement);
      if (after !== lines[i]) { out.push({ path: rel, line: i + 1, before: lines[i], after }); if (out.length >= limit) return out; }
    }
  }
  return out;
}

// ---------- 重名判断与修复（2026-10-06） ----------

/** 重名判断与修复：同名条目分组；可修 → 删除多余的 `&n` 覆盖行（标题回退到文件名）；不可自动修 → 手动提示行。 */
export function scanDuplicates(worldDir, limit = 500) {
  const entries = [];
  for (const rel of collectMarkdown(worldDir)) {
    let text;
    try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    entries.push({ rel, text, e: parseEntry(rel, text) });
  }
  const norm = (v) => String(v || '').trim().replace(/\s+/g, '');
  const groups = new Map();
  for (const x of entries) {
    const base = x.rel.split('/').pop().replace(/\.md$/i, '');
    const k = norm(x.e.title) || norm(base);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const out = [];
  for (const [title, list] of groups) {
    if (list.length < 2) continue;
    const fixable = [];
    const keepers = [];
    for (const x of list) {
      const base = x.rel.split('/').pop().replace(/\.md$/i, '');
      const nOverride = x.e.meta?.n?.[0];
      if (nOverride && norm(nOverride) === title && norm(base) !== title) fixable.push(x);
      else keepers.push(x);
    }
    if (fixable.length && keepers.length) {
      for (const x of fixable) {
        const lines = x.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*&n\s/.test(lines[i])) { out.push({ path: x.rel, line: i + 1, before: lines[i], after: '' }); break; }
        }
      }
      out.push({ manual: true, path: keepers.map((x) => x.rel).join('、'), before: `重名「${title}」保留；以上条目移除 &n 后标题将回退到各自文件名` });
    } else {
      out.push({ manual: true, path: list.map((x) => x.rel).join('、'), before: `重名「${title}」共 ${list.length} 个文件——需手动重命名文件或用 &n 区分` });
    }
    if (out.length >= limit) return out.slice(0, limit);
  }
  return out.slice(0, limit);
}

// ---------- 时间上手（第 82 轮 §12）：为缺 &s 的条目从「时间线文件」提取日期候选 ----------
// 语义：作者的世界通常已有一份「年·事件」时间线文档 → 表格行就是事件↔年份的对应表。
// 保守原则：只解析得动的给候选（无候选 → manual 提示行，绝不硬造）；写入仍走 scan→diff→apply 管线。

/** 年份单元格语义：'约770'/'前300'/'657–700'/'约前100–0' → {y, y2}；'远古/至今/表头/分隔行' → null（不机械化）。 */
export function parseYearCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s.length > 20 || /^[-–—:. ]+$/.test(s)) return null;
  const seg = (t) => {
    const m = /^(约)?(前)?(\d{1,4})$/.exec(String(t).trim());
    if (!m) return null;
    return (m[2] ? -1 : 1) * parseInt(m[3], 10);
  };
  const parts = s.split(/\s*[–—-]\s*/);   // en dash / em dash / hyphen 区间
  if (parts.length === 1) { const y = seg(s); return y == null ? null : { y, y2: null }; }
  if (parts.length === 2) { const a = seg(parts[0]), b = seg(parts[1]); return a == null || b == null ? null : { y: a, y2: b }; }
  return null;
}

/** 年份 → &s/&e 值：时间线只到年 → **一律 `yyyy.*.*`**（月日未知，诚实标模糊；负年 = 前纪）。 */
export function fmtOnboardYear(y) {
  return `${y < 0 ? '-' : ''}${String(Math.abs(y)).padStart(4, '0')}.*.*`;
}

/** 时间线 markdown 表格 → [{y, y2, event}]：只认 `| 年 | 事件 | … |` 行，非年份单元格（表头/分隔/非年事件）跳过。 */
export function parseTimelineTable(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const yr = parseYearCell(cells[1]);
    const ev = cells[2];
    if (!yr || !ev || ev === '事件') continue;
    out.push({ y: yr.y, y2: yr.y2, event: ev });
  }
  return out;
}

/** 标题归一：去编号前缀（'1.7 北伐' → '北伐'；'0.0b 卷一…' → '卷一…'）。 */
const normTitle = (t) => String(t).replace(/^\d+(?:\.\d+)?[a-z]?\s+/i, '').trim();

/**
 * 时间上手扫描 → apply items：
 *  ① 源 A（主）：文件名含「时间线」的 md 表格 → 事件名与条目标题**双向包含**匹配；
 *     多命中取**最早年**（章的主题起始）；单命中且带区间 → `&s &e` 成对。
 *  ② 源 B（兜底）：正文首个点分日期 / `前 yyyy 年`。
 *  ③ 皆无 → `manual` 提示行（不可勾选，不写盘）。
 *  幂等：已有 &s 跳过；`old/`（旧稿目录约定）跳过。
 */
export function scanOnboard(worldDir, limit = 500) {
  const files = collectMarkdown(worldDir);
  let events = [];
  for (const rel of files) {
    if (!/时间线/.test(path.basename(rel))) continue;
    let txt;
    try { txt = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const evs = parseTimelineTable(txt);
    if (evs.length) { events = evs; break; }
  }
  const items = [];
  for (const rel of files) {
    if (items.length >= limit) break;
    if (/(^|\/)old\//i.test(rel)) continue;                     // 旧稿目录约定：不自动上手
    let text;
    try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const e = parseEntry(rel, text);
    if (e.meta?.s?.length) continue;                            // 已有 &s → 幂等跳过
    const title = e.title || path.basename(rel, '.md');
    const isTimelineDoc = /时间线/.test(path.basename(rel));     // 时间线文档是"数据源"，自身不作上手对象
    if (isTimelineDoc) continue;
    const lines = text.split('\n');
    const ai = lines.findIndex((l) => l.trim() !== '');
    if (ai < 0) continue;                                       // 空文件跳过
    const before = lines[ai];                                   // 锚行 = 第一个非空行（&s 插其前）
    const push = (valueLine, src) => items.push({ path: rel, line: ai + 1, before, after: `${valueLine}\n${before}`, src });
    // ① 源 A：时间线事件
    const nt = normTitle(title);
    if (events.length && nt.length >= 2) {
      const hits = events.filter((ev) => ev.event.includes(nt) || nt.includes(ev.event));
      if (hits.length) {
        const y = Math.min(...hits.map((h) => h.y));
        if (hits.length === 1 && hits[0].y2 != null) push(`&s ${fmtOnboardYear(hits[0].y)} &e ${fmtOnboardYear(hits[0].y2)}`, `时间线·${hits[0].event}`);
        else push(`&s ${fmtOnboardYear(y)}`, `时间线·${hits.map((h) => h.event).slice(0, 3).join('、')}${hits.length > 3 ? '…' : ''}`);
        continue;
      }
    }
    // ② 源 B：正文日期
    {
      const m = /(?<![\d.])(前)?(\d{3,4})\.(\d{1,2})\.(\d{1,2})(?!\d)/.exec(text);
      if (m) {
        const y = (m[1] ? -1 : 1) * parseInt(m[2], 10);
        const val = `${y < 0 ? '-' : ''}${String(Math.abs(y)).padStart(4, '0')}.${m[3].padStart(2, '0')}.${m[4].padStart(2, '0')}`;
        push(`&s ${val}`, `正文·${m[0]}`);
        continue;
      }
      const m2 = /(?<![\d.])前(\d{1,4})年(?![\d])/.exec(text);
      if (m2) { push(`&s ${fmtOnboardYear(-parseInt(m2[1], 10))}`, `正文·前${m2[1]}年`); continue; }
    }
    // ③ 无候选 → 提示行（不写盘）
    items.push({ manual: true, path: rel, line: ai + 1, before: `${title} — 无时间候选（可在条目内手填 &s）` });
  }
  return items;
}

// ---------- lint（功能设计 §13：一致性校验；只读，不改文件） ----------

/** lint：返回 [{kind, severity, path, line?, message}]（severity: error | warn | info）。 */
export function lint(worldDir, limit = 800) {
  const files = collectMarkdown(worldDir);
  const entries = [];
  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    entries.push({ rel, text, e: parseEntry(rel, text) });
  }
  const nameOf = (rel, title) => [title, rel, rel.replace(/\.md$/i, ''), rel.split('/').pop().replace(/\.md$/i, '')].filter(Boolean);
  const targets = new Set();
  const titles = [...new Set(entries.map(({ e }) => e.title).filter(Boolean))];   // 漂移近似候选（第 86 轮 §13）
  const allLinkTexts = new Set();
  for (const { rel, e } of entries) {
    for (const n of nameOf(rel, e.title)) targets.add(n);
    for (const l of e.links || []) allLinkTexts.add(String(l).trim());
  }
  const items = [];
  const push = (it) => { if (items.length < limit) items.push(it); };
  const LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

  for (const { rel, text, e } of entries) {
    const lines = text.split('\n');
    // ① 悬空双链（逐处）
    for (let i = 0; i < lines.length; i++) {
      let m;
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(lines[i]))) {
        const t = m[1].trim();
        if (!t || targets.has(t) || targets.has(t + '.md')) continue;
        // 漂移提示（第 86 轮 §13）：悬空目标与现存标题编辑距离 ≤2 → 消息内附正名建议（工具箱「拼写漂移」一键归并）
        const near = titles.find((ti) => ti !== t && dist(ti, t) <= 2);
        push({ kind: 'dangling', severity: 'error', path: rel, line: i + 1,
          message: near
            ? `悬空双链：[[${t}]] 无目标 —— 疑似漂移 →《${near}》（工具箱「拼写漂移」可归并）`
            : `悬空双链：[[${t}]] 无目标（待建队列）` });
      }
    }
    // ② 元数据残缺：未知键 / 日期不合规
    for (let i = 0; i < lines.length; i++) {
      if (!/&[a-z](?=\s|$)/.test(lines[i])) continue;
      for (const pr of parseMetadataLine(lines[i])) {
        if (!KEYS.includes(pr.key)) push({ kind: 'meta', severity: 'warn', path: rel, line: i + 1, message: `未知元数据键：&${pr.key}（词表是建议不是锁）` });
        if (pr.key === 's' || pr.key === 'e' || pr.key === 'd') {   // 作成时间同格式校验（第 113 轮）
          for (const v of pr.values) {
            if (!/^-?\d{1,4}\.(\d{2}|\*)\.(\d{2}|\*)$/.test(v)) {
              push({ kind: 'meta', severity: 'warn', path: rel, line: i + 1, message: `日期不合规：&${pr.key} ${v}（应为 yyyy.mm.dd，模糊段用 *）` });
            }
          }
        }
      }
    }
    // ③ &e < &s / ④ &f 缺 &s
    const sOrd = e.meta?.s?.[0] ? parseDate(e.meta.s[0]) : null;
    const eOrd = e.meta?.e?.[0] ? parseDate(e.meta.e[0]) : null;
    if (sOrd != null && eOrd != null && eOrd < sOrd) push({ kind: 'range', severity: 'warn', path: rel, message: `时间区间倒置：&e ${e.meta.e[0]} < &s ${e.meta.s[0]}` });
    if ((e.meta?.f || []).length && !(e.meta?.s || []).length) push({ kind: 'flag', severity: 'warn', path: rel, message: '打了 &f 事件旗标却缺 &s（无法上时间轴）' });
    // ④.5 时间范围校验：缺起始或结束时间的条目全部识别（&f 缺 &s 已由上一项报过则不重复）
    const hasS = (e.meta?.s || []).length > 0;
    const hasE = (e.meta?.e || []).length > 0;
    const hasF = (e.meta?.f || []).length > 0;
    if ((!hasS || !hasE) && !( !hasS && hasF )) {
      let lineNo = 1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*&[a-z]/.test(lines[i])) { lineNo = i + 1; break; }
      }
      const what = !hasS && !hasE ? '缺起始时间 &s 与结束时间 &e（全无时间，不上时间轴）'
        : !hasS ? '缺起始时间 &s（无法上时间轴）'
          : '缺结束时间 &e（瞬时事件——如需时间范围请补）';
      push({ kind: 'timerange', severity: hasS ? 'info' : 'warn', path: rel, line: lineNo, message: `时间范围校验：${what}` });
    }
    // ⑤ 勘误缺链：passage 围栏 status: disproven 无 ref
    for (const f of extractFences(text)) {
      if (f.kind === 'passage' && /status:\s*(disproven|已证伪)/.test(f.content) && !/ref:\s*\S/.test(f.content)) {
        const lineNo = text.slice(0, f.index).split('\n').length;
        push({ kind: 'erratum', severity: 'warn', path: rel, line: lineNo, message: 'passage「已证伪」缺 ref —— 勘误未链接到正确条目' });
      }
    }
  }
  // ⑥ 孤立条目（无出链且无入链；跳过根书）
  for (const { rel, e } of entries) {
    if (!rel.includes('/')) continue;
    if ((e.links || []).length) continue;
    if (nameOf(rel, e.title).some((n) => allLinkTexts.has(n))) continue;
    push({ kind: 'orphan', severity: 'info', path: rel, message: '孤立条目：无入链也无出链' });
  }
  // ⑦ 状态体检（汇总）
  const stat = (k, v) => entries.filter((x) => x.e.meta?.[k]?.[0] === v).length;
  const withTime = entries.filter((x) => (x.e.meta?.s || []).length).length;
  push({
    kind: 'summary', severity: 'info', path: '',
    message: `状态体检：条目 ${entries.length} · 上轴 ${withTime} · canon ${stat('p', 'canon')} · draft ${stat('p', 'draft')} · 悬空 ${items.filter((x) => x.kind === 'dangling').length}`,
  });
  // ⑧ 目录结构规范（第 89 轮）：世界根只允许 README.md / assets/ / books/（非 md 文件不归平台管）
  const stray = [];
  try {
    for (const ent of fs.readdirSync(worldDir, { withFileTypes: true })) {
      const n = ent.name;
      if (n.startsWith('.') || STRUCT.rootDirs.includes(n) || STRUCT.rootFiles.includes(n)) continue;
      if (ent.isFile() && !n.endsWith('.md')) continue;
      stray.push(n);
    }
  } catch { /* 根目录不可读 */ }
  if (stray.length) {
    push({
      kind: 'structure', severity: 'info', path: '',
      message: `目录结构：世界根有 ${stray.length} 项非规范内容（${stray.slice(0, 3).join('、')}${stray.length > 3 ? '…' : ''}）——工具箱「结构规范化」可迁移`,
    });
  }
  return items;
}

/** 备份剪枝（第 78 轮）：`.soliterra/backup-*` 只保留最近 keep 份。
 *  名字内含 ISO 时间戳（字典序 = 时间序），删最旧的；失败静默（剪枝是尽力而为，绝不能影响主流程）。 */
export function pruneBackups(worldDir, keep = 10) {
  const storeDir = path.join(worldDir, '.soliterra');
  let names = [];
  try { names = fs.readdirSync(storeDir).filter((n) => n.startsWith('backup-')).sort(); } catch { return 0; }
  const dead = names.slice(0, Math.max(0, names.length - keep));
  let removed = 0;
  for (const n of dead) {
    try { fs.rmSync(path.join(storeDir, n), { recursive: true, force: true }); removed++; } catch { /* 尽力而为 */ }
  }
  return removed;
}

/** 应用：按 path 分组改文件；写前备份到 .soliterra/backup-<ts>/（写后自动剪枝，保留最近 10 份）。 */
export function apply(worldDir, tool, items) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(worldDir, '.soliterra', `backup-${ts}`);
  const byPath = new Map();
  for (const it of items) {
    if (!byPath.has(it.path)) byPath.set(it.path, []);
    byPath.get(it.path).push(it);
  }
  let changed = 0;
  for (const [rel, list] of byPath) {
    const abs = path.join(worldDir, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    // 备份
    const bAbs = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(bAbs), { recursive: true });
    fs.writeFileSync(bAbs, text, 'utf8');
    // 逐处替换（以行内容匹配，防行号漂移；同内容多处替换用计数）
    const counter = new Map();
    for (const it of list) {
      const key = `${it.before}→${it.after}`;
      const n = counter.get(key) || 0;
      counter.set(key, n + 1);
      const lines = text.split('\n');
      let made = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === it.before) {
          if (made === n) {
            if (it.after === '') lines.splice(i, 1);   // 删除行（重名修复等）
            else lines[i] = it.after;
            made++;
            break;
          }
          made++;
        }
      }
      text = lines.join('\n');
      changed++;
    }
    fs.writeFileSync(abs, text, 'utf8');
  }
  // 第 114 轮：封面重命名联动——文本 &m 已按 before/after 改写，此处移动文件本体
  if (tool === 'cover') {
    for (const it of items) {
      if (!it.rename) continue;
      try {
        const fromAbs = path.join(worldDir, it.rename.from);
        const toAbs = path.join(worldDir, it.rename.to);
        if (fs.existsSync(fromAbs) && !fs.existsSync(toAbs)) fs.renameSync(fromAbs, toAbs);
      } catch { /* 单个失败不阻断其余 */ }
    }
  }
  pruneBackups(worldDir);   // 自动剪枝（保留最近 10 份；尽力而为）
  return { changed, backup: path.relative(worldDir, backupDir) };
}

// ============ 目录结构规范（第 89 轮）============
// 世界 = README.md（介绍）+ assets/（资源：covers 封面 / images 正文图 / maps 地图 / exports 发布产物）
// + books/（书籍一律住这里：`书.md` + `书/` 成对，可嵌套）。平台自身操作只产生此形态；
// 存量世界用「结构规范化」工具迁移（本文件 scanStructure / applyStructure）。

/** 规范常量（单一来源）——各落盘点引用，禁止散写。 */
export const STRUCT = {
  root: 'books',            // 书籍容器
  covers: 'assets/covers',  // 文档封面
  images: 'assets/images',  // 文档内图片
  maps: 'assets/maps',      // 地图文件
  exports: 'assets/exports',// 发布产物（站点等）
  rootFiles: ['README.md'], // 根层允许的文件
  rootDirs: ['assets', 'books'],
};

/** 结构扫描：根层散落的书/文件 → books/；assets 旧子目录（concepts/imported）→ 规范名 + 引用改写。
 *  返回 { items, moves }：items 供工具箱 diff 行展示（move 行带 kind:'move' 与 from/to）。 */
export function scanStructure(worldDir, limit = 500) {
  const items = [];
  const moves = [];
  const push = (it) => { if (items.length < limit) items.push(it); };
  // ① 根层：除 README.md / assets / books / 点文件外——目录与 .md 文件都归入 books/
  for (const ent of fs.readdirSync(worldDir, { withFileTypes: true })) {
    const n = ent.name;
    if (n.startsWith('.') || STRUCT.rootDirs.includes(n) || STRUCT.rootFiles.includes(n)) continue;
    if (ent.isFile() && !n.endsWith('.md')) continue;      // 非 md 文件不归平台管
    const from = n;
    const to = `${STRUCT.root}/${n}`;
    if (ent.isDirectory()) {
      let inner = 0;
      try { inner = collectMarkdown(path.join(worldDir, n)).length; } catch { /* 不可读 */ }
      const hasPair = fs.existsSync(path.join(worldDir, `${n}.md`));   // 同级配对 md → 明确是书（可空目录）
      if (!inner && !hasPair) {
        push({ path: '', line: 0, manual: true, before: `${from}/ —— 无 md 的目录（资源？）：如为书籍请移入 books/，如为资源请移入 assets/` });
        continue;
      }
    }
    if (fs.existsSync(path.join(worldDir, to))) {
      push({ path: from, line: 0, manual: true, before: `${from} —— 目标已存在（${to}），需人工处理` });
      continue;
    }
    const row = {
      kind: 'move', from, to,
      path: ent.isFile() ? from : '', line: 0,
      before: ent.isDirectory() ? `${from}/` : from,
      after: `${to}${ent.isDirectory() ? '/' : ''}`,
    };
    moves.push(row);
    push(row);
  }

  // ② assets 旧子目录 → 规范名（concepts → covers / imported → images），文件级移动 + 重名跳过
  const assetsAbs = path.join(worldDir, 'assets');
  const remaps = [['concepts', 'covers'], ['imported', 'images']];
  const movedNames = new Map();   // 旧目录名 → 真正会移动的文件名集合（引用只改这些，冲突的不动）
  if (fs.existsSync(assetsAbs)) {
    for (const [oldName, newName] of remaps) {
      const oldAbs = path.join(assetsAbs, oldName);
      if (!fs.existsSync(oldAbs) || !fs.statSync(oldAbs).isDirectory()) continue;
      for (const f of fs.readdirSync(oldAbs)) {
        const from = `assets/${oldName}/${f}`;
        const to = `assets/${newName}/${f}`;
        if (fs.existsSync(path.join(worldDir, to))) {
          push({ path: from, line: 0, manual: true, before: `${from} —— 目标已存在，需人工处理` });
          continue;
        }
        const row = { kind: 'move', from, to, path: from, line: 0, before: from, after: to };
        moves.push(row);
        push(row);
        if (!movedNames.has(oldName)) movedNames.set(oldName, new Set());
        movedNames.get(oldName).add(f);
      }
    }
  }

  // ③ 引用改写：正文与 & 行里的 assets/<旧名>/<文件名> → assets/<新名>/<文件名>（仅限真正要移动的文件）
  if (movedNames.size) {
    for (const r of collectMarkdown(worldDir)) {
      let text; try { text = fs.readFileSync(path.join(worldDir, r), 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let after = lines[i];
        for (const [oldName, newName] of remaps) {
          for (const f of movedNames.get(oldName) || []) after = after.split(`assets/${oldName}/${f}`).join(`assets/${newName}/${f}`);
        }
        if (after !== lines[i]) { const row = { path: r, line: i + 1, before: lines[i], after }; moves.push({ kind: 'ref', ...row }); push(row); }
      }
    }
  }
  return { items, moves };
}

/** 结构应用：文本改写（先，按旧路径）+ 移动（后；fs.rename，重名/穿越跳过）；moves 清单存快照目录。 */
export function applyStructure(worldDir, structMoves) {
  const rootAbs = path.resolve(worldDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(rootAbs, '.soliterra', `backup-${ts}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const textItems = structMoves.filter((m) => m.kind !== 'move');
  const moveItems = structMoves.filter((m) => m.kind === 'move');
  let changed = 0;
  let moved = 0;
  // ① 文本改写（搬迁之前做——行匹配按旧路径）
  if (textItems.length) changed = apply(rootAbs, 'structure', textItems).changed;
  // ② 移动
  for (const m of moveItems) {
    const fromAbs = path.resolve(rootAbs, String(m.from || ''));
    const toAbs = path.resolve(rootAbs, String(m.to || ''));
    if (!m.from || !m.to) continue;
    if (!fromAbs.startsWith(rootAbs + path.sep) || !toAbs.startsWith(rootAbs + path.sep)) continue;   // 防穿越
    if (!fs.existsSync(fromAbs) || fs.existsSync(toAbs)) continue;                                    // 冲突跳过
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    moved++;
  }
  // ③ 搬空的旧资产目录清理（concepts / imported）
  for (const d of ['assets/concepts', 'assets/imported']) {
    const abs = path.join(rootAbs, d);
    try { if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs); } catch { /* 留待人工 */ }
  }
  // 移动清单入快照（记录本次搬了什么；回滚靠 git）
  fs.writeFileSync(path.join(backupDir, 'structure-moves.json'), JSON.stringify({ moves: moveItems, at: ts }, null, 2), 'utf8');
  pruneBackups(rootAbs);
  return { changed: changed + moved, moved, refs: changed, backup: path.relative(rootAbs, backupDir) };
}
