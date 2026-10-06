// Soliterra 工具箱（功能设计 §12）——扫描 → diff 预览 → 批量应用（备份 + git 提交）。
// 首批：① 日期时间规范化（yyyy.mm.dd / hh:mm:ss，缺段补 *）② 【【】】→[[]]

import fs from 'node:fs';
import path from 'node:path';
import { collectMarkdown } from './indexer.js';
import { parseEntry, parseMetadataLine, parseDate, extractFences, KEYS } from './parser.js';

// ---------- 规则 ----------

/** 日期：705.9.10→0705.09.10；705/9/10、705-9-10 同理；705.9→0705.09.*.*；705年9月10日→0705.09.10 */
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
  // &s/&e 后的值若为「年.月」两段 → yyyy.mm.*.*
  out = out.replace(/&([se])\s+(-?\d{1,4})\.(\d{1,2}|\*)(?=\s|&|$)/g,
    (_, k, y, m) => {
      const yy = y.startsWith('-') ? '-' + padYear(y.slice(1)) : padYear(y);
      return `&${k} ${yy}.${m === '*' ? '*' : pad2(m)}.*.*`;
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
        push({ kind: 'dangling', severity: 'error', path: rel, line: i + 1, message: `悬空双链：[[${t}]] 无目标（待建队列）` });
      }
    }
    // ② 元数据残缺：未知键 / 日期不合规
    for (let i = 0; i < lines.length; i++) {
      if (!/&[a-z](?=\s|$)/.test(lines[i])) continue;
      for (const pr of parseMetadataLine(lines[i])) {
        if (!KEYS.includes(pr.key)) push({ kind: 'meta', severity: 'warn', path: rel, line: i + 1, message: `未知元数据键：&${pr.key}（词表是建议不是锁）` });
        if (pr.key === 's' || pr.key === 'e') {
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
  return items;
}

/** 应用：按 path 分组改文件；写前备份到 .soliterra/backup-<ts>/。 */
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
  return { changed, backup: path.relative(worldDir, backupDir) };
}
