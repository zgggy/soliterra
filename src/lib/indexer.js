// Soliterra 索引器 —— 扫描世界目录，解析全部 .md，写入 SQLite（可删可重建）。
// 世界上限：千级文件规模，全量扫描 < 1s；运行中由 watcher 做增量。

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseEntry, extractFences } from './parser.js';

const IGNORE = new Set(['.git', '.soliterra', 'node_modules', 'assets']);
const IGNORE_FILES = /^(\.DS_Store|Thumbs\.db|\.gitignore|\.gitattributes)$/i;

/** 递归收集世界内全部 .md（相对路径，POSIX 分隔）。 */
export function collectMarkdown(root) {
  const out = [];
  const walk = (dir, rel) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.') && it.name !== '.') continue;
      if (IGNORE.has(it.name)) continue;
      if (IGNORE_FILES.test(it.name)) continue;
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) walk(path.join(dir, it.name), r);
      else if (it.isFile() && it.name.toLowerCase().endsWith('.md')) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/** 由文件列表构建「同名配对」树：一个节点 = 文件夹 + 可选同名 .md。 */
export function buildTree(mdPaths) {
  const root = { name: '', dir: '', md: null, children: new Map() };
  const ensure = (parts) => {
    let node = root;
    for (const p of parts) {
      if (!node.children.has(p)) node.children.set(p, { name: p, dir: '', md: null, children: new Map() });
      node = node.children.get(p);
    }
    return node;
  };
  for (const p of mdPaths) {
    const parts = p.split('/');
    const fileName = parts.pop();             // X.md
    const base = fileName.replace(/\.md$/i, '');
    const parent = ensure(parts);
    // X/X.md：同名文档挂在 X 节点自身（不创建嵌套同名子节点）
    if (parts.length && parent.name === base) { parent.md = p; continue; }
    if (!parent.children.has(base)) parent.children.set(base, { name: base, dir: '', md: null, children: new Map() });
    parent.children.get(base).md = p;          // 节点可打开
  }
  const finalize = (node, prefix) => {
    node.dir = prefix;
    const kids = [...node.children.values()]
      .map((c) => finalize(c, prefix ? `${prefix}/${c.name}` : c.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    node.children = kids;
    return node;
  };
  return finalize(root, '');
}

function makeSnip(body, term) {
  const i = body.indexOf(term);
  if (i === -1) return '';
  const start = Math.max(0, i - 40);
  const end = Math.min(body.length, i + term.length + 60);
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (start > 0 ? '…' : '') + esc(body.slice(start, i)) + '<mark>' + esc(term) + '</mark>' + esc(body.slice(i + term.length, end)) + (end < body.length ? '…' : '');
}

export class WorldIndex {
  constructor(worldDir) {
    this.worldDir = worldDir;
    const storeDir = path.join(worldDir, '.soliterra');
    fs.mkdirSync(storeDir, { recursive: true });
    this.db = new Database(path.join(storeDir, 'index.db'));
    this.db.pragma('journal_mode = WAL');
    this.#migrate();
    this.#prep();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        path TEXT PRIMARY KEY,
        title TEXT, meta TEXT, tags TEXT, status TEXT,
        start TEXT, end TEXT, flag TEXT, instant INTEGER, fuzzy INTEGER, t_ord REAL,
        body TEXT, mtime INTEGER
      );
      CREATE TABLE IF NOT EXISTS links (src TEXT, dst TEXT);
      CREATE TABLE IF NOT EXISTS rels (src TEXT, dst TEXT, type TEXT);
      CREATE INDEX IF NOT EXISTS links_src ON links(src);
      CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, body);
    `);
  }

  #prep() {
    this.qUpsert = this.db.prepare(`INSERT INTO entries
      (path,title,meta,tags,status,start,end,flag,instant,fuzzy,t_ord,body,mtime)
      VALUES (@path,@title,@meta,@tags,@status,@start,@end,@flag,@instant,@fuzzy,@t_ord,@body,@mtime)
      ON CONFLICT(path) DO UPDATE SET
        title=@title, meta=@meta, tags=@tags, status=@status,
        start=@start, end=@end, flag=@flag, instant=@instant, fuzzy=@fuzzy,
        t_ord=@t_ord, body=@body, mtime=@mtime`);
    this.qDelLinks = this.db.prepare('DELETE FROM links WHERE src=?');
    this.qInsLink = this.db.prepare('INSERT INTO links (src,dst) VALUES (?,?)');
    this.qDelRels = this.db.prepare('DELETE FROM rels WHERE src=?');
    this.qInsRel = this.db.prepare('INSERT INTO rels (src,dst,type) VALUES (?,?,?)');
    this.qDelFts = this.db.prepare('DELETE FROM fts WHERE path=?');
    this.qInsFts = this.db.prepare('INSERT INTO fts (path,title,body) VALUES (?,?,?)');
  }

  /** 全量重建（索引可随时删除重建，不丢任何数据）。 */
  rebuild() {
    const paths = collectMarkdown(this.worldDir);
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM entries; DELETE FROM links; DELETE FROM rels; DELETE FROM fts;');
      for (const p of paths) this.indexFile(p);
    });
    tx();
    return paths.length;
  }

  /** 单文件增量索引（由 watcher / API 调用）。 */
  indexFile(rel) {
    const abs = path.join(this.worldDir, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const e = parseEntry(rel, text);
    const tl = e.timeline;
    this.qUpsert.run({
      path: rel, title: e.title, meta: JSON.stringify(e.meta),
      tags: e.tags.join(' '), status: e.status || null,
      start: tl?.start.text ?? null, end: tl?.end.text ?? null, flag: tl?.flag ?? null,
      instant: tl ? (tl.instant ? 1 : 0) : null, fuzzy: tl ? (tl.fuzzy ? 1 : 0) : null,
      t_ord: tl?.start.ord ?? null,
      body: e.body, mtime: Date.now(),
    });
    this.qDelLinks.run(rel);
    for (const dst of e.links) this.qInsLink.run(rel, dst);
    // rel 围栏 → 关系强边（from/to/type）
    this.qDelRels.run(rel);
    for (const f of extractFences(text)) {
      if (f.kind !== 'rel') continue;
      const kv = {};
      for (const line of f.content.split('\n')) {
        const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
        if (m) kv[m[1]] = m[2].trim();
      }
      if (kv.from && kv.to) this.qInsRel.run(rel, kv.from, kv.type || '');
    }
    this.qDelFts.run(rel);
    this.qInsFts.run(rel, e.title, e.body);
  }

  removeFile(rel) {
    this.db.prepare('DELETE FROM entries WHERE path=?').run(rel);
    this.qDelLinks.run(rel);
    this.qDelFts.run(rel);
  }

  tree() {
    const paths = this.db.prepare('SELECT path,title,start,flag,tags,meta FROM entries').all();
    const byPath = new Map(paths.map((r) => [r.path, r]));
    const tree = buildTree([...byPath.keys()]);
    const decorate = (node) => {
      if (node.md) {
        const r = byPath.get(node.md);
        node.title = r?.title || node.name;
        node.tags = r?.tags ? r.tags.split(' ') : [];
        node.hasTime = !!r?.start;
        node.flag = r?.flag || null;
        try {
          const mm = JSON.parse(r?.meta || '{}');
          node.cover = mm.m?.[0] || null;
          const v = (mm.v && mm.v[0]) || '';

        } catch { node.cover = null; }
      }
      node.children.forEach(decorate);
    };
    decorate(tree);
    return tree;
  }

  entry(rel) {
    const r = this.db.prepare('SELECT * FROM entries WHERE path=?').get(rel);
    if (!r) return null;
    return {
      ...r,
      meta: JSON.parse(r.meta || '{}'),
      links: this.db.prepare('SELECT DISTINCT dst FROM links WHERE src=?').all(rel).map((x) => x.dst),
      backlinks: this.db.prepare('SELECT DISTINCT src FROM links WHERE dst=?').all(r.title).map((x) => x.src)
        .concat(this.db.prepare('SELECT DISTINCT src FROM links WHERE dst=?').all(rel.replace(/\.md$/i, '')).map((x) => x.src)),
    };
  }

  search(q, limit = 30) {
    const term = q?.trim();
    if (!term) return [];
    // 1) FTS5：英文词 / 长查询（unicode61 分词）
    let rows = [];
    const clean = term.replace(/["'*()^:]/g, ' ').trim();
    if (clean) {
      try {
        rows = this.db.prepare(
          `SELECT f.path, f.title, snippet(fts, 2, '<mark>', '</mark>', '…', 12) AS snip
           FROM fts f WHERE fts MATCH ? ORDER BY rank LIMIT ?`
        ).all(clean, limit);
      } catch { rows = []; }
    }
    // 2) LIKE 子串兜底：CJK 短词（"三力"）在 unicode61 下不成词，子串扫描
    if (rows.length === 0) {
      const like = `%${term}%`;
      rows = this.db.prepare(
        `SELECT path, title, body FROM entries
         WHERE title LIKE ? OR body LIKE ? LIMIT ?`
      ).all(like, like, limit).map((r) => ({
        path: r.path, title: r.title, snip: makeSnip(r.body || '', term),
      }));
    }
    return rows;
  }

  timeline() {
    return this.db.prepare(
      `SELECT path,title,start,end,flag,instant,fuzzy,t_ord,
              json_extract(meta,'$.a[0]') AS era,
              json_extract(meta,'$.t') AS tags_json
       FROM entries
       WHERE start IS NOT NULL ORDER BY t_ord ASC`
    ).all();
  }

  /** 双链目标名 → 条目（title / 路径 / 文件名匹配）。 */
  resolve(name) {
    const target = String(name || '').trim();
    if (!target) return null;
    const rows = this.db.prepare('SELECT path, title FROM entries').all();
    return rows.find((r) => r.title === target)
      || rows.find((r) => r.path === target || r.path === target + '.md')
      || rows.find((r) => r.path.replace(/\.md$/i, '') === target)
      || rows.find((r) => r.path.split('/').pop().replace(/\.md$/i, '') === target)
      || null;
  }

  /** 一跳关系图：中心 + 出链（+可选反链）邻居与边。 */
  graph(rel, includeBacklinks) {
    const center = this.entry(rel);
    if (!center) return null;
    const nodes = new Map([[rel, { path: rel, title: center.title, center: true }]]);
    const edges = [];
    for (const dst of center.links) {
      const hit = this.resolve(dst);
      if (!hit || hit.path === rel) continue;
      nodes.set(hit.path, { path: hit.path, title: hit.title });
      edges.push({ from: rel, to: hit.path, kind: 'link' });
    }
    if (includeBacklinks) {
      for (const src of center.backlinks) {
        if (!src || src === rel) continue;
        const hit = this.entry(src);
        if (!hit) continue;
        nodes.set(hit.path, { path: hit.path, title: hit.title });
        edges.push({ from: hit.path, to: rel, kind: 'link' });
      }
    }
    // rel 围栏强边（出向；含反链时并入入向）
    const relRows = includeBacklinks
      ? this.db.prepare('SELECT src,dst,type FROM rels WHERE src=? OR dst=?').all(rel, rel)
      : this.db.prepare('SELECT src,dst,type FROM rels WHERE src=?').all(rel);
    for (const r2 of relRows) {
      const srcPath = r2.src === rel ? rel : this.resolve(r2.src)?.path;
      const dstPath = r2.dst === rel ? rel : this.resolve(r2.dst)?.path;
      if (!srcPath || !dstPath || srcPath === dstPath) continue;
      if (!nodes.has(srcPath)) { const e2 = this.entry(srcPath); if (e2) nodes.set(srcPath, { path: srcPath, title: e2.title }); }
      if (!nodes.has(dstPath)) { const e2 = this.entry(dstPath); if (e2) nodes.set(dstPath, { path: dstPath, title: e2.title }); }
      edges.push({ from: srcPath, to: dstPath, kind: 'rel', type: r2.type || '' });
    }
    return { center: rel, nodes: [...nodes.values()], edges };
  }

  /** 仪表盘（功能设计 §15.4）：条目/双链/标签/深度/警报/git 活跃一览。 */
  dashboard(worldDir) {
    const entries = this.db.prepare('SELECT path,title,tags FROM entries').all();
    const links = this.db.prepare('SELECT DISTINCT src,dst FROM links').all();
    const rows = entries;
    const byTitle = new Map(rows.map((r) => [r.title, r.path]));
    const byPath = new Map(rows.map((r) => [r.path, r.path]));
    const byBase = new Map(rows.map((r) => [r.path.split('/').pop().replace(/\.md$/i, ''), r.path]));
    const resolveName = (n) => byTitle.get(n) || byPath.get(n) || byBase.get(n) || null;
    const outEdges = new Set();
    const dangling = [];
    for (const l of links) {
      const to = resolveName(l.dst);
      if (to && to !== l.src) outEdges.add(l.src + '→' + to);
      else dangling.push(l.dst);
    }
    const hasIn = new Set([...outEdges].map((e) => e.split('→')[1]));
    const hasOut = new Set([...outEdges].map((e) => e.split('→')[0]));
    const isolated = entries.filter((r) => !r.path.includes('/')).length
      ? entries.filter((r) => r.path.includes('/') && !hasIn.has(r.path) && !hasOut.has(r.path)).length
      : 0;
    const tagCount = new Map();
    for (const r of entries) for (const t of (r.tags || '').split(/\s+/).filter(Boolean)) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const tags = [...tagCount].sort((a2, b2) => b2[1] - a2[1]).slice(0, 8).map(([t2, n]) => ({ t: t2, n }));
    let maxDepth = 0;
    const walk = (node, d) => { if (node.md && d > maxDepth) maxDepth = d; for (const c of node.children) walk(c, d + 1); };
    walk(this.tree(), 0);
    return {
      entries: entries.length,
      links: outEdges.size,
      dangling: new Set(dangling).size,
      isolated,
      tags,
      maxDepth,
      books: this.tree().children.filter((c) => c.md || c.children.length).length,
    };
  }

  /** 全库关系图（功能设计 §9.3）：全部有边的条目 + 去重边；超限取连接度 Top N。 */
  graphAll(limit = 150) {
    const rows = this.db.prepare('SELECT path,title,tags FROM entries').all();
    const links = this.db.prepare('SELECT DISTINCT src,dst FROM links').all();
    const byTitle = new Map(rows.map((r) => [r.title, r.path]));
    const byPath = new Map(rows.map((r) => [r.path, r.path]));
    const byBase = new Map(rows.map((r) => [r.path.split('/').pop().replace(/\.md$/i, ''), r.path]));
    const resolveName = (n) => byTitle.get(n) || byPath.get(n) || byBase.get(n) || null;
    const degree = new Map();
    const edges = [];
    for (const l of links) {
      const to = resolveName(l.dst);
      if (to && to !== l.src) {
        edges.push({ from: l.src, to, kind: 'link' });
        degree.set(l.src, (degree.get(l.src) || 0) + 1);
        degree.set(to, (degree.get(to) || 0) + 1);
      }
    }
    for (const r3 of this.db.prepare('SELECT DISTINCT src,dst,type FROM rels').all()) {
      const to = resolveName(r3.dst);
      if (to && to !== r3.src) {
        edges.push({ from: r3.src, to, kind: 'rel', type: r3.type || '' });
        degree.set(r3.src, (degree.get(r3.src) || 0) + 1);
        degree.set(to, (degree.get(to) || 0) + 1);
      }
    }
    let nodes = rows.filter((r) => degree.has(r.path));
    if (nodes.length > limit) {
      nodes = nodes.sort((a, b) => (degree.get(b.path) || 0) - (degree.get(a.path) || 0)).slice(0, limit);
    }
    const keep = new Set(nodes.map((n) => n.path));
    const finalEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    return {
      nodes: nodes.map((n) => ({ path: n.path, title: n.title, tags: n.tags ? n.tags.split(' ') : [] })),
      edges: finalEdges,
    };
  }

  stats() {
    const n = this.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    const links = this.db.prepare('SELECT COUNT(*) c FROM links').get().c;
    const events = this.db.prepare('SELECT COUNT(*) c FROM entries WHERE start IS NOT NULL').get().c;
    return { entries: n, links, events };
  }

  close() { try { this.db.close(); } catch {} }
}
