// Soliterra 解析器 —— 平台语法的唯一实现处。
// 规则来源：docs/平台设计方案.md §二.5 / §五，docs/功能设计.md §1 / §3.1。

// 单字母键表（可扩展；未知键原样保留并可由 lint 提示）
export const KEYS = ['s', 'e', 't', 'f', 'n', 'a', 'p', 'v', 'q', 'm', 'r', 'w', 'd'];   // &r=顺序(91) · &w=作者 &d=作成时间(113，in-world)

// 匹配「& + 一个小写字母 + 空格或行尾」——正文里的 "A & B"、"Tom & Jerry" 不受影响
const KEY_RE = /&([a-z])(?=\s|$)/g;

// 第 122 轮（条目名可含空格）：值段语义全部在 shared/meta.js（前后端单点）——
// 值断于下一个 &关键字或行尾、双引号整体包裹（引号内 &键 不作键）、仅 &t 分词。
import { keyMatches, parseValueSpan } from '../shared/meta.js';
export { formatMetaValue, replaceKeyInLine, replaceKeyInText } from '../shared/meta.js';

export function parseMetadataLine(line) {
  const ms = keyMatches(line);
  return ms.map((m, i) => {
    const end = i + 1 < ms.length ? ms[i + 1].idx : line.length;
    return { key: m.key, values: parseValueSpan(line.slice(m.valStart, end), m.key) };
  });
}

/**
 * 解析整篇文本的元数据（任意行、可多行；同键后者覆盖前者）。
 * @returns {{ meta: Record<string, string[]>, metaLines: number[] }}
 */
export function parseMetadata(text) {
  const meta = {};
  const metaLines = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const pairs = parseMetadataLine(lines[i]);
    if (pairs.length === 0) continue;
    // 仅当整行（去首尾空白后）几乎全由元数据对构成时，才视为元数据行，
    // 防止正文中的偶发 "&x" 被吞。判定：首个键之前的文本为空或仅空白。
    const first = lines[i].indexOf('&' + pairs[0].key);
    if (lines[i].slice(0, first).trim() !== '') continue;
    metaLines.push(i);
    for (const p of pairs) {
      if (KEYS.includes(p.key) || p.key) meta[p.key] = p.values; // 后者覆盖前者
    }
  }
  return { meta, metaLines };
}

/** 抽取 [[双链]] / ![[嵌入]] 的目标（含 #锚，剥离别名）。 */
export function extractLinks(text) {
  const links = [];
  const re = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  for (const m of text.matchAll(re)) {
    const target = m[1].trim();
    if (target && !links.includes(target)) links.push(target);
  }
  return links;
}

/** 条目显示标题：&n > 首个 # 标题 > 文件名。 */
export function entryTitle(meta, body, filename) {
  if (meta.n && meta.n[0]) return meta.n[0];
  const h = body.match(/^#{1,3}\s+(.+)$/m);
  if (h) return h[1].trim();
  return filename.replace(/\.md$/i, '');
}

/** 时间标记 → 可排序数值。日期 yyyy.mm.dd，* 为模糊段；返回 null 表示无。 */
export function parseDate(str) {
  if (!str) return null;
  const m = String(str).match(/^(-?)(\d{1,4})\.(\d{1,2}|\*)\.(\d{1,2}|\*)$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const year = parseInt(m[2], 10) * sign;
  const month = m[3] === '*' ? null : parseInt(m[3], 10);
  const day = m[4] === '*' ? null : parseInt(m[4], 10);
  const fuzzy = month === null || day === null;
  // 粗序数：按 365.25 天/年折算，便于时间轴像素映射
  const ord = year * 365.25 + ((month ?? 6) - 1) * 30.44 + ((day ?? 15) - 1);
  return { year, month, day, fuzzy, ord, text: str };
}

/** 从 meta 组装时间轴数据。 */
export function timelineInfo(meta) {
  const s = parseDate(meta.s?.[0]);
  const e = parseDate(meta.e?.[0]);
  if (!s) return null;
  return {
    start: s,
    end: e || s,             // 缺 &e → 瞬时
    instant: !e,
    fuzzy: s.fuzzy || (e ? e.fuzzy : false),   // 合并布尔（≈ 前缀兼容用）
    fuzzyS: s.fuzzy,          // 逐端语义（第 76 轮：数据层单点真相，前端不再解析 * 串）
    fuzzyE: e ? e.fuzzy : false,
    flag: meta.f?.[0] || null, // &f <分类> 悬挂旗标
  };
}

/** 提取 ``` 围栏扩展块（event/rel/term/scene/passage…）。 */
export function extractFences(text) {
  const fences = [];
  const re = /^```(\w+)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (const m of text.matchAll(re)) {
    const kind = m[1];
    if (['event', 'rel', 'term', 'scene', 'passage'].includes(kind)) {
      fences.push({ kind, content: m[2], index: m.index });
    }
  }
  return fences;
}

/** 去除元数据行，得正文（用于渲染与检索）。 */
export function stripMetaLines(text, metaLines) {
  const lines = text.split('\n');
  const set = new Set(metaLines);
  return lines.filter((_, i) => !set.has(i)).join('\n');
}

/** 一站式解析一个 md 文件。 */
/**
 * 深层 YAML frontmatter 兼容读取（第 86 轮 §15.6）：文件头 `---` 块 → 剥离 + 三键映射。
 * 规则：`^---` 起、首个对称 `---` 止，且块内至少一行 `key:` 才认定（文中 `---` 分割线不误剥）；
 * 嵌套子键/引号/行内数组/块数组/块标量 → 整块安全剥离（文件不动、渲染不显示）；
 * `title/tags/status` → `&n/&t/&p`（**& 行优先**，已有键不被覆盖）；其余键仅隐藏不进 meta。
 */
export function splitFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { fm: null, body: String(text) };
  const block = m[1];
  if (!/^[A-Za-z_][\w-]*\s*:/m.test(block)) return { fm: null, body: String(text) };   // 非键值块（如纯分割线）不剥
  const fm = {};
  let key = null;
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']')) fm[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      else if (v === '') fm[key] = [];
      else if (v === '|' || v === '>' || /^[|>][+-]?$/.test(v)) fm[key] = [];            // 块标量（值在后续缩进行——内容保留在文件，此处不取）
      else fm[key] = v.replace(/^['"]|['"]$/g, '');
    } else {
      const item = line.match(/^\s+-\s+(.*)$/);                                          // 块数组项
      if (item && key) {
        const val = item[1].trim().replace(/^['"]|['"]$/g, '');
        if (Array.isArray(fm[key])) fm[key].push(val);
        else fm[key] = (Array.isArray(fm[key]) ? fm[key] : (fm[key] ? [fm[key]] : [])).concat(val);
      }
      // 其余行（嵌套子键 `sub: v`、注释、纯文本）——忽略：整块已被剥离，文件未动
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

export function parseEntry(path, text) {
  const filename = path.split('/').pop();
  const { fm, body: noFm } = splitFrontmatter(text);
  const { meta, metaLines } = parseMetadata(noFm);
  if (fm) {
    // 三键映射（& 行优先；与 Obsidian 导入同语义）
    if (typeof fm.title === 'string' && fm.title && !meta.n) meta.n = [fm.title];
    if (!meta.t && fm.tags) meta.t = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
    if (typeof fm.status === 'string' && fm.status && !meta.p) meta.p = [fm.status];
  }
  const body = stripMetaLines(noFm, metaLines);
  const title = entryTitle(meta, body, filename);
  const links = extractLinks(text);
  const tl = timelineInfo(meta);
  return {
    path,
    title,
    meta,
    body,
    links,
    fences: extractFences(text),
    timeline: tl,
    tags: meta.t || [],
    status: meta.p?.[0] || null,
  };
}
