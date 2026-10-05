// Soliterra 渲染器 —— markdown-it + 平台扩展（双链 / 元数据芯片 / callout / 围栏块）。
// 输出 HTML 由前端注入；双链保留 data-target 由前端拦截点击。

import MarkdownIt from 'markdown-it';
import { parseMetadataLine, KEYS } from './parser.js';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Inline rule：[[目标|别名]] 与 ![[嵌入]]
function wikiRule(state, silent) {
  const start = state.pos;
  const src = state.src;
  const embed = src.startsWith('![[', start);
  const open = embed ? '![[' : '[[';
  if (!src.startsWith(open, start)) return false;
  const close = src.indexOf(']]', start + open.length);
  if (close === -1) return false;
  const inner = src.slice(start + open.length, close);
  const [targetPart, aliasPart] = inner.split('|');
  const [target, anchor] = targetPart.split('#');
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.content = inner;
    token.meta = { embed, target: (target || '').trim(), anchor: (anchor || '').trim(), alias: (aliasPart || '').trim() };
  }
  state.pos = close + 2;
  return true;
}
// 证伪链接：~~[[目标|文字]]~~（红色删除线 + 超链），注册在普通双链之前
function refutedRule(state, silent) {
  const start = state.pos;
  const src = state.src;
  if (!src.startsWith('~~[[', start)) return false;
  const close = src.indexOf(']]~~', start + 4);
  if (close === -1) return false;
  const inner = src.slice(start + 4, close);
  const [targetPart, aliasPart] = inner.split('|');
  if (!silent) {
    const token = state.push('refutedlink', '', 0);
    token.meta = { target: (targetPart || '').trim(), alias: (aliasPart || '').trim() };
  }
  state.pos = close + 4;
  return true;
}
md.inline.ruler.before('link', 'wikilink', wikiRule);
md.inline.ruler.before('strikethrough', 'refutedlink', refutedRule);   // 先于内置删除线，避免 ~~[[ ]]~~ 被拆成 <s><a>
md.renderer.rules.refutedlink = (tokens, idx) => {
  const { target, alias } = tokens[idx].meta;
  return `<a class="wikilink wikilink-refuted" data-target="${esc(target)}" data-refuted="1">${esc(alias || target)}</a>`;
};

const DEFAULT_WIKILINK = (tokens, idx) => {
  const { embed, target, anchor, alias } = tokens[idx].meta;
  const label = alias || (anchor ? `${target} § ${anchor}` : target);
  const cls = `wikilink${embed ? ' wikilink-embed' : ''}`;
  return `<a class="${cls}" data-target="${esc(target)}"${anchor ? ` data-anchor="${esc(anchor)}"` : ''}>${esc(label)}</a>`;
};
md.renderer.rules.wikilink = DEFAULT_WIKILINK;

/** 带嵌入解析的渲染器（resolver: (target, anchor) => {html} | null；embed 无命中退回链接）。 */
function makeWikilink(resolver) {
  return (tokens, idx) => {
    const { embed, target, anchor, alias } = tokens[idx].meta;
    if (embed && resolver) {
      const frag = resolver(target, anchor);
      if (frag && frag.html) {
        return `<div class="embed-block"><span class="embed-eyebrow">嵌入 · ${esc(target)}${anchor ? ` § ${esc(anchor)}` : ''}</span>${frag.html}</div>`;
      }
    }
    return DEFAULT_WIKILINK(tokens, idx);
  };
}

/** 从正文里取某标题小节（含标题行，到下一个同级/更高级标题为止）；未命中返回 null。 */
export function sectionOf(text, anchor) {
  const lines = String(text).split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim() === String(anchor).trim()) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}

/** 嵌入片段渲染（深度 1：片段内 ![[ ]] 退回链接；callout 带视图分级；勘误态由 renderFences 继承）。 */
export function renderFragment(text, view = 'author') {
  const prev = md.renderer.rules.wikilink;
  md.renderer.rules.wikilink = DEFAULT_WIKILINK;
  let html = md.render(text);
  md.renderer.rules.wikilink = prev;
  html = renderCallouts(html, view);
  html = renderFences(html);
  return { html };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 元数据 → 标题区结构：
//   上方行 = [&q 可信度(换色,最前)] [&p 状态(换色)] [&f 事件] [&t 标签…] [&a 时代] [&v 可见性]（全部浅字）
//   标题右侧 = &s – &e（浅字，底对齐）
const STATUS_ZH = { canon: '正典', draft: '草稿', disputed: '存疑', deprecated: '废弃' };
const STATUS_EN = { canon: 'Canon', draft: 'Draft', disputed: 'Disputed', deprecated: 'Deprecated' };

export function entryMetaParts(meta, lang) {
  const top = [];
  if (meta.q?.[0]) top.push(`<button class="m-item m-q" data-key="q">${esc(meta.q[0])}</button>`);
  if (meta.p?.[0]) {
    const label = (lang === 'en' ? STATUS_EN : STATUS_ZH)[meta.p[0]] || meta.p[0];
    top.push(`<button class="m-item m-p" data-key="p">${esc(label)}</button>`);
  }
  if (meta.f?.[0]) top.push(`<button class="m-item m-f" data-key="f">${esc(meta.f[0])}</button>`);
  for (const t of meta.t || []) top.push(`<button class="m-item m-t" data-key="t">${esc(t)}</button>`);
  if (meta.a?.[0]) top.push(`<button class="m-item m-a" data-key="a">${esc(meta.a[0])}</button>`);
  if (meta.v?.[0]) top.push(`<button class="m-item m-v" data-key="v">${esc(meta.v[0])}</button>`);
  const topMetaHTML = top.length ? `<div class="entry-meta-top">${top.join('')}</div>` : '';
  const rangeHTML = meta.s?.[0]
    ? `<span class="entry-range"><button class="m-item m-s" data-key="s">${esc(meta.s[0])}</button><span class="m-dash">–</span><button class="m-item m-e" data-key="e">${esc(meta.e?.[0] || '')}</button></span>`
    : '';
  return { topMetaHTML, rangeHTML };
}

// callout：> [!档案] 标题\n> 内容
function renderCallouts(html, view = 'author') {   // 视图分级 §15.3：读者视图 [!作者] 隐藏、[!剧透] 折叠
  return html.replace(/<blockquote>\s*<p>\[!(\S+?)\]\s*([^<]*?)(?:<br\s*\/?>|\n)?([\s\S]*?)<\/p>\s*<\/blockquote>/g,
    (_, kind, title, rest) => {
      const map = { '档案': 'archive', '存疑': 'doubt', '作者': 'author', '剧透': 'spoiler' };
      const cls = map[kind] || 'note';
      const cleanRest = rest.replace(/<\/p>\s*<p>/g, '</p><p>');
      if (view === 'reader' && kind === '作者') return '';
      if (view === 'reader' && kind === '剧透') {
        return `<details class="callout callout-spoiler-fold"><summary><span class="callout-kind">剧透</span>${title ? `<span class="callout-title">${esc(title)}</span>` : ''}</summary><div class="callout-body"><p>${cleanRest}</p></div></details>`;
      }
      return `<aside class="callout callout-${cls}"><span class="callout-kind">${esc(kind)}</span>${title ? `<span class="callout-title">${esc(title)}</span>` : ''}<div class="callout-body"><p>${cleanRest}</p></div></aside>`;
    });
}

// 围栏块（event/rel/term/scene/passage）→ 键值角标块
function renderFences(html) {
  return html.replace(/<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g, (whole, lang, code) => {
    if (!['event', 'rel', 'term', 'scene', 'passage'].includes(lang)) return whole;
    const text = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const lines = text.split('\n');
    const head = [];
    let i = 0;
    for (; i < lines.length; i++) {
      const m = lines[i].match(/^\s*([\w-]+):\s*(.*)$/);
      if (m) head.push(`<div class="fence-kv"><span class="fence-k">${esc(m[1])}</span><span class="fence-v">${esc(m[2])}</span></div>`);
      else break;
    }
    const rest = lines.slice(i).join('\n').replace(/^---\s*$/m, '').trim();
    // 勘误（§8.4 方向 A）：passage + status: disproven/disputed → 徽章 + 勘误行（ref 链接到正确段落）
    let badge = '';
    let annotation = '';
    if (lang === 'passage') {
      const kv = {};
      for (const line of lines) {
        const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
        if (m) kv[m[1]] = m[2].trim();
      }
      const st = kv.status || '';
      if (st === 'disproven' || st === '已证伪' || st === 'disputed' || st === '存疑') {
        const disproven = st === 'disproven' || st === '已证伪';
        badge = `<span class="fence-badge ${disproven ? 'is-disproven' : 'is-disputed'}">${disproven ? '已证伪' : '存疑'}</span>`;
        const ref = kv.ref || '';
        const m2 = ref.match(/\[\[([^\]|#]+)(?:#([^\]|]+))?/);
        const target = m2 ? m2[1].trim() : '';
        const anchor = m2 ? (m2[2] || '').trim() : '';
        annotation = disproven
          ? `<div class="annotation-row"><span class="ann-kind">与正典不符</span>${target ? ` · 详见 <a class="wikilink" data-target="${esc(target)}"${anchor ? ` data-anchor="${esc(anchor)}"` : ''}>${esc(target)}${anchor ? ' § ' + esc(anchor) : ''}</a>` : ' · <span class="ann-missing">勘误未链接（lint：勘误缺链）</span>'}</div>`
          : `<div class="annotation-row is-disputed"><span class="ann-kind">存疑</span>${target ? ` · 参见 <a class="wikilink" data-target="${esc(target)}"${anchor ? ` data-anchor="${esc(anchor)}"` : ''}>${esc(target)}</a>` : ''}</div>`;
        return `<div class="fence-block fence-${lang} ${disproven ? 'fence-disproven' : 'fence-disputed'}"><span class="fence-tag">${lang}</span>${badge}<div class="fence-head">${head.join('')}</div>${rest ? `<div class="fence-body">${md.render(rest)}</div>` : ''}${annotation}</div>`;
      }
    }
    return `<div class="fence-block fence-${lang}"><span class="fence-tag">${lang}</span><div class="fence-head">${head.join('')}</div>${rest ? `<div class="fence-body">${md.render(rest)}</div>` : ''}</div>`;
  });
}

/**
 * 渲染条目正文。
 * @param {string} body 已剥离元数据行的正文
 * @param {object} meta 元数据
 */
export function renderEntry(body, meta, title, lang, view = 'author', resolver = null) {
  // 正文首个 H1 与条目标题相同时移除（避免与 entry-title 重复）
  let src = body;
  const h1 = src.match(/^#\s+(.+)\s*$/m);
  if (h1 && (!title || h1[1].trim() === title)) {
    src = src.replace(/^#\s+.+\s*$/m, '');
  }
  const prevWiki = md.renderer.rules.wikilink;
  md.renderer.rules.wikilink = resolver ? makeWikilink(resolver) : DEFAULT_WIKILINK;
  let html = md.render(src);
  md.renderer.rules.wikilink = prevWiki;
  html = renderCallouts(html, view);
  html = renderFences(html);
  const { topMetaHTML, rangeHTML } = entryMetaParts(meta || {}, lang);
  return { html, topMetaHTML, rangeHTML };
}
