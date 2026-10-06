// Soliterra 只读站点发布（功能设计 §15.7）：世界 → 静态 HTML 站点，落盘 assets/exports/site-<ts>/。
// 原则：正文渲染与应用同款管线（renderEntry）；产物纯静态（无 JS）；发布边界 = 排除 &v 作者（安全默认）。
// 链接三处防泄漏：隐藏条目不生成页、不进目录树、指向它的 wikilink 不出 href、被它嵌入的 ![[ ]] 退回链接。

import fs from 'node:fs';
import path from 'node:path';
import { collectMarkdown } from './indexer.js';
import { parseEntry } from './parser.js';
import { renderEntry, renderFragment, sectionOf } from './render.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 可见性（发布边界）：`&v 作者` = 作者私货不外传；秘传/公众/无 &v 全含。visibility='all' 时全含（API/测试用）。 */
export function isPublished(meta, visibility = 'public') {
  if (visibility === 'all') return true;
  return meta?.v?.[0] !== '作者';
}

/** 站内相对链接：from → to（posix 相对，同目录无前缀）。 */
const relTo = (fromRel, toRel) => path.posix.relative(path.posix.dirname(fromRel), toRel) || path.posix.basename(toRel);

/**
 * 后处理（对单页 html）：
 *  ① wikilink `<a class="wikilink…" data-target="X" [data-anchor]>` → 补 `href="相对.html"`；
 *     resolve 失败 / 目标被隐藏 → 不出 href（可点性关闭，杜绝死链）；
 *  ② 元数据浅字 `<button class="m-item…" data-key>` → `<span>`（静态站无编辑语义）；
 *  ③ 正文图片 `assets/…` → 按页面深度相对化（外链 http(s)/data 不动），并收集待复制清单。
 */
function postProcess(html, { curRel, resolveTarget, assetsOut }) {
  let out = html;
  // ① wikilink（含勘误态 data-refuted、annotation-row 内 data-anchor）
  out = out.replace(
    /<a class="(wikilink[^"]*)"([^>]*?)data-target="([^"]+)"([^>]*)>/g,
    (whole, cls, pre, target, post2) => {
      const href = resolveTarget(target);   // null → 不出 href
      if (!href) return `<a class="${cls}"${pre}data-target="${esc(target)}"${post2}>`;
      return `<a class="${cls}"${pre}data-target="${esc(target)}" data-site-href="${esc(href)}"${post2}>`;
    },
  );
  out = out.replace(/ data-site-href="([^"]+)"/g, (_, h) => ` href="${h}"`);
  // ② m-item 按钮 → span（button 内只有文本，无嵌套）
  out = out.replace(/<button class="(m-item[^"]*)" data-key="[^"]*">([^<]*)<\/button>/g, '<span class="$1">$2</span>');
  // ③ 图片相对化 + 收集
  out = out.replace(/src="(?!https?:|data:|\/)([^"]+)"/g, (whole, src) => {
    if (!src.startsWith('assets/')) return whole;   // 非世界资产（如站内生成物）不动
    const rel = relTo(curRel, src);
    assetsOut.add(src);
    return `src="${rel}"`;
  });
  return out;
}

/** 目录树（仅可见条目）→ index.html 内嵌 ul。语义：有 children = 目录节点（file 标记 = 配对条目可点）；仅 file = 条目。 */
function buildTreeHtml(paths, titles) {
  const nodes = new Map();
  for (const p of [...paths].sort()) {
    const parts = p.split('/');
    let cur = nodes;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      const key = parts.slice(0, i + 1).join('/');
      if (!cur.has(name)) cur.set(name, { name, key, file: false, children: new Map() });
      const node = cur.get(name);
      if (isFile) node.file = true;
      cur = node.children;
    }
  }
  const mdKey = (nodeKey) => nodeKey.replace(/\.html$/, '.md');   // 树节点 key 带 .html，titles 键是 .md
  const render = (map) => {
    const lis = [...map.values()].map((n) => {
      if (n.children.size) {
        // 目录节点：配对条目（X/ 与 X.md 并存）→ 标题链接到 X.html；纯目录 → 纯文本
        const hasPair = n.file && titles.has(mdKey(n.key));
        const label = hasPair
          ? `<a href="${esc(n.key + '.html')}">${esc(titles.get(mdKey(n.key)) || n.name)}</a>`
          : `<span>${esc(n.name)}</span>`;
        return `<li class="site-dir">${label}${render(n.children)}</li>`;
      }
      const t = titles.get(mdKey(n.key)) || n.name.replace(/\.html$/, '');
      return `<li class="site-file"><a href="${esc(n.key)}">${esc(t)}</a></li>`;
    });
    return `<ul>${lis.join('')}</ul>`;
  };
  return render(nodes);
}

/**
 * 打包世界为只读站点。
 * @returns { dir, rel, pages, hidden, assets, world } — dir=绝对路径；rel=世界根相对路径
 */
export function buildSite(worldDir, { visibility = 'public', lang = 'zh-CN' } = {}) {
  const files = collectMarkdown(worldDir);
  // ① 逐条解析 + 可见性
  const entries = [];   // { rel, title, meta, body }
  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(worldDir, rel), 'utf8'); } catch { continue; }
    const e = parseEntry(rel, text);
    entries.push({ rel, title: e.title, meta: e.meta, body: e.body });
  }
  const visible = entries.filter((e) => isPublished(e.meta, visibility));
  const hidden = entries.length - visible.length;
  const visibleSet = new Set(visible.map((e) => e.rel));
  const byTitle = new Map();   // 目标名（idx.resolve 同款语义：title / 路径 / 文件名）→ 可见条目
  for (const e of visible) {
    byTitle.set(e.title, e);
    byTitle.set(e.rel, e);
    byTitle.set(e.rel.replace(/\.md$/i, ''), e);
    byTitle.set(path.posix.basename(e.rel).replace(/\.md$/i, ''), e);
  }
  const resolveVisible = (target) => {
    const t = String(target || '').trim();
    return byTitle.get(t) || byTitle.get(`${t}.md`) || null;
  };

  const outDir = path.join(worldDir, 'assets', 'exports', `site-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const assetsOut = new Set();
  const titles = new Map();   // rel(带 .md) → title（目录树用）

  // ② 按世界树先序（collectMarkdown 顺序近似先序；显式按路径排序保证稳定 prev/next）
  const ordered = [...visible].sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  let pages = 0;
  ordered.forEach((e, i) => {
    const relHtml = e.rel.replace(/\.md$/i, '.html');
    titles.set(e.rel, e.title);
    const resolver = (target, anchor) => {
      const hit = resolveVisible(target);            // 隐藏/不存在 → null → 退回链接（防泄漏）
      if (!hit) return null;
      let text = hit.body || '';
      if (anchor) { const sec = sectionOf(text, anchor); if (!sec) return null; text = sec; }
      return renderFragment(text);
    };
    const { html, topMetaHTML, rangeHTML } = renderEntry(e.body, e.meta, e.title, lang, resolver);
    const up = relHtml.split('/').length > 1 ? '../'.repeat(relHtml.split('/').length - 1) : '';
    const nav = [
      `<a href="${up}index.html">← ${esc(worldBaseName(worldDir))}</a>`,
      i > 0 ? `<a href="${esc(relTo(relHtml, ordered[i - 1].rel.replace(/\.md$/i, '.html')))}">← 上一篇</a>` : '',
      i < ordered.length - 1 ? `<a class="site-next" href="${esc(relTo(relHtml, ordered[i + 1].rel.replace(/\.md$/i, '.html')))}">下一篇 →</a>` : '',
    ].filter(Boolean).join('');
    const ppOpts = { curRel: relHtml, resolveTarget: (t) => { const h = resolveVisible(t); return h ? relTo(relHtml, h.rel.replace(/\.md$/i, '.html')) : null; }, assetsOut };
    let page = postProcess(html, ppOpts);
    const metaTop = postProcess(topMetaHTML, ppOpts);    // 元数据浅字区同过后处理（m-item button → span）
    const range = postProcess(rangeHTML, ppOpts);
    page = `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(e.title)} · ${esc(worldBaseName(worldDir))}</title>
<link rel="stylesheet" href="${up}style.css"></head>
<body><div class="world-view site-page"><main class="reader-column">
${metaTop}
<div class="entry-title-row"><h1 class="entry-title">${esc(e.title)}</h1>${range}</div>
<div class="entry-body">${page}</div>
<nav class="entry-nav site-nav">${nav}</nav>
</main></div></body></html>
`;
    const abs = path.join(outDir, relHtml);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, page, 'utf8');
    pages++;
  });

  // ③ 首页：世界名 + 简介 + 封面 + 目录树
  const root = worldBaseName(worldDir);
  const rootEntry = resolveVisible(`${root}.md`) || resolveVisible(root);
  const intro = rootEntry ? String(rootEntry.body || '').replace(/^#.*$/m, '').trim().slice(0, 400) : '';
  const cover = rootEntry?.meta?.m?.[0] || null;
  const indexHtml = `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(root)}</title>
<link rel="stylesheet" href="style.css"></head>
<body><div class="world-view site-page"><main class="reader-column">
<h1 class="entry-title">${esc(root)}</h1>
${cover ? `<img class="site-cover" src="${esc(relTo('index.html', cover))}" alt="">` : ''}
${intro ? `<div class="entry-body site-intro">${esc(intro).replace(/\n+/g, '<br>')}</div>` : ''}
<nav class="site-tree-nav eyebrow">目录</nav>
<div class="site-tree">${buildTreeHtml([...visibleSet].map((r) => r.replace(/\.md$/i, '.html')), titles)}</div>
</main></div></body></html>
`;
  fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml, 'utf8');
  pages++;

  // ④ style.css：复制 app.css（无 url() 引用，已核实）+ 站点专用段
  const appCss = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(outDir, 'style.css'), appCss + SITE_CSS, 'utf8');

  // ⑤ 图片资源按需复制
  let assets = 0;
  for (const src of assetsOut) {
    const from = path.join(worldDir, src);
    const to = path.join(outDir, src);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      assets++;
    } catch { /* 图片缺失 → 页面 img 自然 404（与应用内一致，不阻断打包） */ }
  }
  // 封面（若存在且被引用）
  if (cover) {
    const from = path.join(worldDir, cover);
    const to = path.join(outDir, cover);
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); assets++; } catch { /* 无封面文件 */ }
  }

  return { dir: outDir, rel: path.relative(worldDir, outDir).replace(/\\/g, '/'), pages, hidden, assets, world: root };
}

/** 世界名 = 世界目录名（根条目标题兜底已在首页处理）。 */
function worldBaseName(worldDir) {
  return path.basename(worldDir);
}

/** 站点专用样式（追加在 app.css 之后；只管新类，不改既有）。 */
const SITE_CSS = `
/* —— 只读站点（§15.7）—— */
body { margin: 0; background: var(--bg); }
.site-page .reader-column { padding-top: 40px; }
.site-nav { display: flex; gap: 14px; justify-content: space-between; margin: 32px 0 48px; border-top: 1px solid var(--line); padding-top: 14px; }
.site-nav a { color: var(--text-muted); text-decoration: none; font-family: var(--font-ui); font-size: .78rem; }
.site-nav a:hover { color: var(--text); }
.site-tree-nav { display: block; margin: 28px 0 8px; }
.site-tree ul { list-style: none; margin: 0; padding-left: 18px; }
.site-tree > ul { padding-left: 0; }
.site-tree li { padding: 3px 0; }
.site-tree a { color: var(--text); text-decoration: none; border-bottom: 1px solid var(--line); }
.site-tree a:hover { border-bottom-color: var(--line-strong); }
.site-tree .site-dir > span { color: var(--text-muted); }
.site-tree .site-dir > a { font-weight: 600; border-bottom-color: var(--line-strong); }
.site-cover { display: block; max-width: 240px; margin: 18px 0; border: 1px solid var(--line); }
.site-intro { color: var(--text-muted); }
.site-page img { max-width: 100%; }
`;
