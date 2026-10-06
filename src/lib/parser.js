// Soliterra 解析器 —— 平台语法的唯一实现处。
// 规则来源：website/平台设计方案.md §二.5 / §五，website/功能设计.md §1 / §3.1。

// 单字母键表（可扩展；未知键原样保留并可由 lint 提示）
export const KEYS = ['s', 'e', 't', 'f', 'n', 'a', 'p', 'v', 'q', 'm'];

// 匹配「& + 一个小写字母 + 空格或行尾」——正文里的 "A & B"、"Tom & Jerry" 不受影响
const KEY_RE = /&([a-z])(?=\s|$)/g;

/**
 * 解析一行内的元数据对。值由空格分割，断于下一个键或行尾。
 * @returns {Array<{key: string, values: string[]}>}
 */
export function parseMetadataLine(line) {
  const pairs = [];
  const matches = [...line.matchAll(KEY_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length; // 键后
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
    const values = line.slice(start, end).trim().split(/\s+/).filter(Boolean);
    pairs.push({ key: m[1], values });
  }
  return pairs;
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
export function parseEntry(path, text) {
  const filename = path.split('/').pop();
  const { meta, metaLines } = parseMetadata(text);
  const body = stripMetaLines(text, metaLines);
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
