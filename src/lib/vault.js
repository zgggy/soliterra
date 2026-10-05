// Soliterra 世界管理 —— 发现 / 创建 / 索引缓存 / 文件监听。
// 世界 = 一个 git 仓库目录；平台不预设任何内容目录，只管理 assets/ 与 .soliterra/。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import chokidar from 'chokidar';
import { WorldIndex, collectMarkdown } from './indexer.js';

export class Vault {
  constructor(worldsDir) {
    this.worldsDir = path.resolve(worldsDir);
    fs.mkdirSync(this.worldsDir, { recursive: true });
    this.indexes = new Map();   // worldId -> WorldIndex
    this.watchers = new Map();  // worldId -> chokidar watcher
  }

  worldDir(id) {
    const dir = path.join(this.worldsDir, id);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(this.worldsDir + path.sep)) throw new Error('invalid world id');
    return resolved;
  }

  /** 世界信息（从根条目与统计读取）。 */
  worldInfo(id) {
    const dir = this.worldDir(id);
    const idx = this.index(id);
    const stats = idx.stats();
    // 根条目：与目录同名的 md
    const rootMd = `${id}.md`;
    const root = idx.entry(rootMd);
    let cover = root?.meta?.m?.[0] || null;
    // 封面可见性：assets 下直接可服务
    return {
      id,
      name: root?.title || id,
      subtitle: firstLine(root?.body) || '',
      cover,
      description: firstParagraph(root?.body) || '',
      stats,
    };
  }

  list() {
    const out = [];
    for (const it of fs.readdirSync(this.worldsDir, { withFileTypes: true })) {
      if (!it.isDirectory() && !it.isSymbolicLink()) continue;
      if (it.name.startsWith('.')) continue;
      try {
        const dir = path.join(this.worldsDir, it.name);
        const hasMd = collectMarkdown(fs.realpathSync(dir)).length > 0;
        if (!hasMd && !fs.existsSync(path.join(dir, '.soliterra'))) continue;
        out.push(this.worldInfo(it.name));
      } catch { /* 跳过不可读目录 */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  /** 第一个标题行之外的首段文字（简介兜底）。 */
  index(id) {
    if (!this.indexes.has(id)) {
      const idx = new WorldIndex(this.worldDir(id));
      idx.rebuild();
      this.indexes.set(id, idx);
      this.watch(id);
    }
    return this.indexes.get(id);
  }

  watch(id) {
    if (this.watchers.has(id)) return;
    const dir = this.worldDir(id);
    // chokidar v4 只接受函数/正则 ignored（glob 已移除）——按路径段过滤
    const ignored = (p) => {
      const rel = path.relative(dir, p);
      if (!rel) return false;
      return rel.split(path.sep).some((seg) => seg === 'node_modules' || seg === '.soliterra' || seg === 'assets' || seg.startsWith('.'));
    };
    const w = chokidar.watch(dir, {
      ignored,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });
    w.on('error', (err) => console.error(`[watch:${id}]`, err.message));
    const idx = this.indexes.get(id);
    w.on('add', (f) => { if (f.endsWith('.md')) idx.indexFile(path.relative(dir, f)); });
    w.on('change', (f) => { if (f.endsWith('.md')) idx.indexFile(path.relative(dir, f)); });
    w.on('unlink', (f) => { if (f.endsWith('.md')) idx.removeFile(path.relative(dir, f)); });
    this.watchers.set(id, w);
  }

  /** 保存条目正文（MVP：仅正文 + 原元数据行保留）。 */
  saveEntry(id, rel, text) {
    const dir = this.worldDir(id);
    const abs = path.join(dir, rel);
    const resolved = path.resolve(abs);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error('invalid path');
    if (!resolved.endsWith('.md')) throw new Error('not markdown');
    fs.writeFileSync(resolved, text, 'utf8');
    this.index(id).indexFile(rel);
    return true;
  }

  readEntryRaw(id, rel) {
    const dir = this.worldDir(id);
    const resolved = path.resolve(path.join(dir, rel));
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error('invalid path');
    return fs.readFileSync(resolved, 'utf8');
  }

  /** 保存上传图片到 assets/imported/（重名加序号）；返回相对路径。 */
  saveAsset(id, name, buf) {
    const dir = this.worldDir(id);
    const safe = String(name || 'image.png').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '') || 'image.png';
    const ext = path.extname(safe).toLowerCase();
    const base = path.basename(safe, path.extname(safe)) || 'image';
    const targetDir = path.join(dir, 'assets', 'imported');
    fs.mkdirSync(targetDir, { recursive: true });
    let rel = `assets/imported/${base}${ext}`;
    let i = 2;
    while (fs.existsSync(path.join(dir, rel))) { rel = `assets/imported/${base}-${i}${ext}`; i++; }
    fs.writeFileSync(path.join(dir, rel), buf);
    return rel;
  }

  /** assets/ 全量图片列表（缩略图选择器用；按修改时间倒序）。 */
  listAssets(id) {
    const root = path.join(this.worldDir(id), 'assets');
    const out = [];
    const walk = (rel) => {
      let names = [];
      try { names = fs.readdirSync(path.join(root, rel)); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        const r = rel ? `${rel}/${n}` : n;
        let st;
        try { st = fs.statSync(path.join(root, r)); } catch { continue; }
        if (st.isDirectory()) walk(r);
        else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(n)) out.push({ path: `assets/${r}`, size: st.size, mtime: st.mtimeMs });
      }
    };
    walk('');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** 创建世界：目录 + 根条目 + assets + .gitignore + git init。 */
  create({ name, subtitle = '', timeline = '', cover = '', calendar = '' }) {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('invalid world name');
    const dir = path.join(this.worldsDir, name);
    if (fs.existsSync(dir)) throw new Error('world already exists');
    fs.mkdirSync(path.join(dir, 'assets', 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.soliterra/\n', 'utf8');
    const meta = [`&n ${name}`, cover ? `&m ${cover}` : ''].filter(Boolean).join(' ');
    const calLine = calendar ? `<!-- calendar: ${calendar} -->` : '';
    // 时间线：多行事件（每行含 &s）→ 独立条目 `时间线/NN-标题.md`；单行普通文字 → 根正文
    const tlLines = String(timeline || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const eventLines = tlLines.filter((x) => /&s\s/.test(x));
    const plainLines = tlLines.filter((x) => !/&s\s/.test(x));
    const body = [`# ${name}`, '', subtitle || '', calLine && ['', calLine], '', plainLines.join('\n')].flat().filter((x) => x !== undefined).join('\n');
    fs.writeFileSync(path.join(dir, `${name}.md`), `${meta}\n\n${body}\n`, 'utf8');
    eventLines.forEach((line, i) => {
      // 标题 = 行内元数据段之外的裸文本；无裸文本则取 &f 首词
      const fval = (line.match(/&f\s+([^&]*)/) || [])[1]?.trim() || '';
      const rest = line.replace(/&[a-z]\s+[^&]*/g, '').replace(/&[a-z]\b/g, '').trim();
      const title = (rest || fval.split(/\s+/)[0] || `事件${i + 1}`).replace(/\s+/g, '');
      const safeTitle = String(title).replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || `事件${i + 1}`;
      const idx2 = String(i + 1).padStart(2, '0');
      const rel = path.join('时间线', `${idx2}-${safeTitle}.md`);
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `${line}\n\n# ${safeTitle}\n`, 'utf8');
    });
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=Soliterra', '-c', 'user.email=soliterra@local',
        'commit', '-q', '-m', `init: 创建世界 ${name}`], { cwd: dir });
    } catch { /* git 不可用时静默（世界仍可读写） */ }
    return this.worldInfo(name);
  }

  /** 世界级操作（§1.1）：重命名 / 复制 / 删除（移入 worlds/.trash-<ts>/，list() 跳过点目录）。 */
  _worldNameCheck(name) {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('invalid world name');
    const dst = path.join(this.worldsDir, name);
    if (fs.existsSync(dst)) throw new Error('已存在同名世界: ' + name);
    return dst;
  }

  renameWorld(id, newName) {
    const from = path.join(this.worldsDir, id);
    if (!fs.existsSync(from)) throw new Error('world not found: ' + id);
    const to = this._worldNameCheck(newName);
    fs.renameSync(from, to);
    // 改名后根条目 &n 若等于旧名 → 同步（同 entry rename 语义）
    try {
      const rootMd = path.join(to, `${id}.md`);
      if (fs.existsSync(rootMd)) {
        let t = fs.readFileSync(rootMd, 'utf8');
        if (/^&n\s/m.test(t)) t = t.replace(/^&n\s.*$/m, `&n ${newName}`);
        fs.writeFileSync(rootMd, t, 'utf8');
      }
    } catch { /* 根条目同步失败不影响改名 */ }
    this.indexes.delete(id);
    const w = this.watchers.get(id);
    if (w) { try { w.close(); } catch {} this.watchers.delete(id); }
    return this.worldInfo(newName);
  }

  duplicateWorld(id, newName) {
    const from = path.join(this.worldsDir, id);
    if (!fs.existsSync(from)) throw new Error('world not found: ' + id);
    const to = this._worldNameCheck(newName);
    fs.cpSync(from, to, { recursive: true });
    try {
      const rootMd = path.join(to, `${id}.md`);
      if (fs.existsSync(rootMd)) {
        let t = fs.readFileSync(rootMd, 'utf8');
        if (/^&n\s/m.test(t)) t = t.replace(/^&n\s.*$/m, `&n ${newName}`);
        fs.renameSync(rootMd, path.join(to, `${newName}.md`));
        fs.writeFileSync(path.join(to, `${newName}.md`), t, 'utf8');
      }
    } catch { /* 根条目改名失败则保留原名（内容仍可读） */ }
    return this.worldInfo(newName);
  }

  deleteWorld(id) {
    const from = path.join(this.worldsDir, id);
    if (!fs.existsSync(from)) throw new Error('world not found: ' + id);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const trash = path.join(this.worldsDir, `.trash-${ts}`);
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(from, path.join(trash, id));
    this.indexes.delete(id);
    const w = this.watchers.get(id);
    if (w) { try { w.close(); } catch {} this.watchers.delete(id); }
    return { trashed: path.join(`.trash-${ts}`, id) };
  }

  /** Obsidian 导入（§15.6）：复制整库为新世界，frontmatter 转写 & 元数据，双链原样，图片入 assets/imported/。不动原库。 */
  importObsidian({ src, name }) {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('invalid world name');
    const srcAbs = path.resolve(src || '');
    if (!src || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isDirectory()) throw new Error('库路径不存在: ' + src);
    const dest = path.join(this.worldsDir, name);
    if (fs.existsSync(dest)) throw new Error('world already exists');
    const skip = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
    const walk = (dir, cb) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(ent.name) || ent.name.startsWith('.')) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, cb);
        else cb(abs);
      }
    };
    // 1) 图片先行：全库图片 → assets/imported/<文件名>（重名加序号）
    const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
    const imgMap = new Map();          // 库内文件名（含/不含扩展） → 相对路径
    let imgCount = 0;
    fs.mkdirSync(path.join(dest, 'assets', 'imported'), { recursive: true });
    walk(srcAbs, (abs) => {
      const ext = path.extname(abs).toLowerCase();
      if (!IMG.has(ext)) return;
      const base = path.basename(abs);
      const stem = base.replace(/\.[^.]+$/, '');
      let saved = `assets/imported/${base}`;
      let n = 1;
      while (fs.existsSync(path.join(dest, saved))) saved = `assets/imported/${path.basename(base, ext)}-${n++}${ext}`;
      fs.copyFileSync(abs, path.join(dest, saved));
      imgMap.set(base, saved);
      imgMap.set(stem, saved);
      imgCount++;
    });
    // 2) frontmatter → & 元数据；其余键保留为 obsidian 注释
    const parseFM = (text) => {
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      if (!m) return { fm: null, body: text };
      const fm = {};
      let key = null;
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) {
          key = kv[1];
          const v = kv[2].trim();
          if (v.startsWith('[') && v.endsWith(']')) fm[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^#/, '').replace(/^['"]|['"]$/g, '')).filter(Boolean);
          else if (v === '') fm[key] = [];
          else fm[key] = v.replace(/^['"]|['"]$/g, '');
        } else {
          const item = line.match(/^\s+-\s+(.*)$/);
          if (item && key) {
            const val = item[1].trim().replace(/^['"]|['"]$/g, '');
            if (Array.isArray(fm[key])) fm[key].push(val);
            else fm[key] = [fm[key]].filter(Boolean).concat(val);
          }
        }
      }
      return { fm, body: text.slice(m[0].length) };
    };
    // 3) 嵌入图片改写
    const rewrite = (mdText, mdDir) => mdText
      .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (whole, target, alias) => {
        const t = target.trim();
        const saved = imgMap.get(t) || imgMap.get(t.replace(/\.[^.]+$/, ''));
        if (!saved) return whole;
        return alias ? `![${alias}](${saved})` : `![](${saved})`;
      })
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, srcPath) => {
        if (srcPath.startsWith('http') || srcPath.startsWith('assets/')) return whole;
        const rel = srcPath.split('?')[0].split('#')[0];
        const cand = [path.resolve(mdDir, rel), path.resolve(srcAbs, rel)];
        for (const c of cand) {
          if (fs.existsSync(c) && IMG.has(path.extname(c).toLowerCase())) {
            const saved = imgMap.get(path.basename(c));
            if (saved) return `![${alt}](${saved})`;
          }
        }
        return whole;
      });
    // 4) 转换并写盘（保持目录结构）
    const mds = [];
    walk(srcAbs, (abs) => { if (abs.endsWith('.md')) mds.push(abs); });
    let count = 0;
    for (const abs of mds) {
      const rel = path.relative(srcAbs, abs);
      const raw = fs.readFileSync(abs, 'utf8');
      const { fm, body } = parseFM(raw);
      const meta = [];
      const comments = [];
      if (fm) {
        if (fm.title) meta.push(`&n ${fm.title}`);
        if (Array.isArray(fm.tags) && fm.tags.length) meta.push(`&t ${fm.tags.join(' ')}`);
        if (fm.status) meta.push(`&p ${fm.status}`);
        for (const [k, v] of Object.entries(fm)) {
          if (k === 'title' || k === 'tags' || k === 'status') continue;
          comments.push(`<!-- obsidian: ${k}: ${Array.isArray(v) ? v.join(', ') : v} -->`);
        }
      }
      const out = [
        ...meta, ...(meta.length ? [''] : []),
        ...comments, ...(comments.length ? [''] : []),
        rewrite(body, path.dirname(abs)),
      ].join('\n');
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out, 'utf8');
      count++;
    }
    // 5) git init（同 create）
    fs.writeFileSync(path.join(dest, '.gitignore'), '.soliterra/\n', 'utf8');
    try {
      execFileSync('git', ['init', '-q'], { cwd: dest });
      execFileSync('git', ['add', '-A'], { cwd: dest });
      execFileSync('git', ['-c', 'user.name=Soliterra', '-c', 'user.email=soliterra@local',
        'commit', '-q', '-m', `init: 从 Obsidian 导入 ${name}（${count} 条目，${imgCount} 图片）`], { cwd: dest });
    } catch { /* git 不可用时静默 */ }
    return { name, entries: count, images: imgCount };
  }

  /** 结构操作三件套（§5.4 操作流②③④ + 重命名/删除）：全部 md⇄目录成对；不自动提交。 */
  _safe(dir, rel) {
    const abs = path.resolve(path.join(dir, rel));
    if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new Error('invalid path');
    return abs;
  }

  /** 新建条目：parentDir（''=根）+ name；pair=true 时同时建同名目录（书/可打开节点）。 */
  createEntry(id, parentDir, name, pair = false) {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('invalid name');
    const dir = this.worldDir(id);
    const rel = path.join(parentDir || '', `${name}.md`);
    const abs = this._safe(dir, rel);
    if (fs.existsSync(abs)) throw new Error('已存在同名条目: ' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `&n ${name}\n\n# ${name}\n`, 'utf8');
    if (pair) fs.mkdirSync(path.join(dir, parentDir || '', name), { recursive: true });
    this.index(id).indexFile(rel);
    return { path: rel.replace(/\\/g, '/') };
  }

  /** 重命名：md 与同名目录成对改名（目录存在时）。 */
  renameEntry(id, rel, newName) {
    if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error('invalid name');
    const dir = this.worldDir(id);
    const from = this._safe(dir, rel);
    if (!fs.existsSync(from)) throw new Error('source not found: ' + rel);
    const base = rel.replace(/\.md$/i, '');
    const newRel = `${base.replace(/[^/]+$/, newName)}.md`;
    const to = this._safe(dir, newRel);
    if (fs.existsSync(to)) throw new Error('已存在同名条目: ' + newRel);
    const dirFrom = this._safe(dir, base);
    const dirTo = this._safe(dir, `${base.replace(/[^/]+$/, newName)}`);
    fs.renameSync(from, to);
    if (fs.existsSync(dirFrom)) fs.renameSync(dirFrom, dirTo);
    // 双侧同步：文件内的 &n 行跟随新名（否则显示标题残留旧名）；无 &n 则标题回退新文件名
    try {
      let text = fs.readFileSync(to, 'utf8');
      if (/^&n\s/m.test(text)) text = text.replace(/^&n\s.*$/m, `&n ${newName}`);
      else text = `&n ${newName}\n` + text;
      fs.writeFileSync(to, text, 'utf8');
    } catch { /* 内容改写失败不影响改名本身 */ }
    this.index(id).removeFile(rel);
    this.index(id).indexFile(newRel);
    // 目录内子文件路径都变了 → 子树重建
    if (fs.existsSync(dirTo)) {
      const idx = this.index(id);
      const reRel = (newRel.replace(/\.md$/i, ''));
      const walk = (abs) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
          if (ent.isDirectory()) walk(path.join(abs, ent.name));
          else if (ent.name.endsWith('.md')) idx.indexFile(path.relative(dir, path.join(abs, ent.name)));
        }
      };
      walk(dirTo);
    }
    return { path: newRel.replace(/\\/g, '/') };
  }

  /** 删除：md + 同名目录整体移入 .soliterra/trash-<ts>/（不进 git）。 */
  deleteEntry(id, rel) {
    const dir = this.worldDir(id);
    const from = this._safe(dir, rel);
    if (!fs.existsSync(from)) throw new Error('source not found: ' + rel);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const trash = path.join(dir, '.soliterra', `trash-${ts}`, path.dirname(rel));
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(from, path.join(trash, path.basename(from)));
    const base = rel.replace(/\.md$/i, '');
    const dirFrom = this._safe(dir, base);
    if (fs.existsSync(dirFrom)) fs.renameSync(dirFrom, path.join(trash, path.basename(base)));
    this.index(id).removeFile(rel);
    // 子树从索引移除
    const idx = this.index(id);
    const absBase = dirFrom;
    if (fs.existsSync(path.join(trash, path.basename(base)))) {
      const walk = (abs, prefix) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
          const r2 = path.join(prefix, ent.name);
          if (ent.isDirectory()) walk(path.join(abs, ent.name), r2);
          else if (ent.name.endsWith('.md')) idx.removeFile(r2.replace(/\\/g, '/'));
        }
      };
      walk(path.join(trash, path.basename(base)), base);
    }
    return { trashed: path.relative(dir, path.join(trash, path.basename(from))).replace(/\\/g, '/') };
  }

  /** 移动条目/节点（成对联动：X.md ⇄ X/）。from: 相对路径（目录节点以 / 结尾或实际目录）；toDir: 目标父目录（相对，'' = 根）。 */
  moveEntry(id, relFrom, toDir) {
    const dir = this.worldDir(id);
    const rootAbs = path.resolve(dir);
    const fromAbs = path.resolve(path.join(dir, relFrom.replace(/\/$/, '')));
    if (!fromAbs.startsWith(rootAbs + path.sep)) throw new Error('invalid path');
    if (!fs.existsSync(fromAbs)) throw new Error('source not found');
    const isDir = fs.statSync(fromAbs).isDirectory();
    const base = path.basename(fromAbs);
    const targetDirAbs = path.resolve(path.join(dir, toDir || ''));
    if (!targetDirAbs.startsWith(rootAbs)) throw new Error('invalid target');
    if (targetDirAbs === fromAbs || targetDirAbs.startsWith(fromAbs + path.sep)) throw new Error('cannot move into itself');
    if (path.dirname(fromAbs) === targetDirAbs) throw new Error('already there');
    const moves = [];
    const toRel = (abs) => path.relative(dir, abs).split(path.sep).join('/');
    if (isDir) {
      fs.mkdirSync(targetDirAbs, { recursive: true });
      const dest = path.join(targetDirAbs, base);
      if (fs.existsSync(dest)) throw new Error('target exists');
      fs.renameSync(fromAbs, dest);
      moves.push([relFrom.replace(/\/$/, ''), toRel(dest)]);
      const mdFrom = path.join(path.dirname(fromAbs), base + '.md');
      if (fs.existsSync(mdFrom)) {
        const mdDest = path.join(targetDirAbs, base + '.md');
        fs.renameSync(mdFrom, mdDest);
        moves.push([toRel(mdFrom), toRel(mdDest)]);
      }
    } else {
      if (!base.toLowerCase().endsWith('.md')) throw new Error('only markdown movable');
      fs.mkdirSync(targetDirAbs, { recursive: true });
      const dest = path.join(targetDirAbs, base);
      if (fs.existsSync(dest)) throw new Error('target exists');
      fs.renameSync(fromAbs, dest);
      moves.push([toRel(fromAbs), toRel(dest)]);
      // 叶子 X.md 若同目录存在 X/ 一并联动
      const sideDir = path.join(path.dirname(fromAbs), base.replace(/\.md$/i, ''));
      if (fs.existsSync(sideDir) && fs.statSync(sideDir).isDirectory()) {
        const sideDest = path.join(targetDirAbs, base.replace(/\.md$/i, ''));
        if (!fs.existsSync(sideDest)) {
          fs.renameSync(sideDir, sideDest);
          moves.push([toRel(sideDir), toRel(sideDest)]);
        }
      }
    }
    // 索引更新
    const idx = this.index(id);
    for (const [oldR, newR] of moves) {
      idx.removeFile(oldR);
      if (newR.toLowerCase().endsWith('.md')) idx.indexFile(newR);
    }
    return { moves };
  }

  // ---------- UI 偏好与稍后阅读（.soliterra/，允许的非 .md 文件） ----------
  settingsPath(id) { return path.join(this.worldDir(id), '.soliterra', 'settings.json'); }
  getSettings(id) {
    try { return JSON.parse(fs.readFileSync(this.settingsPath(id), 'utf8')); }
    catch { return {}; }
  }
  saveSettings(id, patch) {
    const cur = this.getSettings(id);
    const next = { ...cur, ...patch };
    fs.mkdirSync(path.dirname(this.settingsPath(id)), { recursive: true });
    fs.writeFileSync(this.settingsPath(id), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  readlaterPath(id) { return path.join(this.worldDir(id), '.soliterra', 'readlater.json'); }
  getReadlater(id) {
    try { return JSON.parse(fs.readFileSync(this.readlaterPath(id), 'utf8')); }
    catch { return []; }
  }
  setReadlater(id, list) {
    fs.mkdirSync(path.dirname(this.readlaterPath(id)), { recursive: true });
    fs.writeFileSync(this.readlaterPath(id), JSON.stringify(list, null, 2), 'utf8');
    return list;
  }
  addReadlater(id, item) {
    const list = this.getReadlater(id).filter((x) => x.path !== item.path);
    list.push(item); // 加入顺序 = 列表顺序（顶对齐）
    return this.setReadlater(id, list);
  }
  removeReadlater(id, relPath) {
    return this.setReadlater(id, this.getReadlater(id).filter((x) => x.path !== relPath));
  }

  // ---------- git ----------
  gitInfo(id) {
    const dir = this.worldDir(id);
    try {
      const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      const last = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h%x09%s%x09%cr'], { encoding: 'utf8' }).trim().split('\t');
      return { ok: true, branch, hash: last[0] || '', message: last[1] || '', when: last[2] || '' };
    } catch { return { ok: false }; }
  }

  /** 提交历史（功能设计 §15.6）：等宽 hash + 消息 + 时间。 */
  gitLog(id, limit = 50) {
    const dir = this.worldDir(id);
    try {
      const out = execFileSync('git', ['-C', dir, 'log', `-${limit}`, '--format=%h%x09%s%x09%ad', '--date=format:%Y-%m-%d %H:%M'], { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean).map((l) => {
        const [hash, subject, when] = l.split('\t');
        return { hash, subject, when };
      });
    } catch { return []; }
  }

  /** 近 N 天提交数（仪表盘 git 活跃）。 */
  gitCommitsSince(id, days = 7) {
    try {
      const out = execFileSync('git', ['-C', this.worldDir(id), 'log', `--since=${days} days ago`, '--oneline'], { encoding: 'utf8' }).trim();
      return out ? out.split('\n').filter(Boolean).length : 0;
    } catch { return 0; }
  }

  /** 某提交的文件清单（含状态 M/A/D 对比上一提交）。 */
  gitShow(id, rev) {
    const dir = this.worldDir(id);
    try {
      const out = execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', 'show', '--name-status', '--format=', rev], { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean).map((l) => {
        const [status, ...rest] = l.split('\t');
        return { status, path: rest.join('\t') };
      });
    } catch { return []; }
  }

  /** 某提交下某文件的内容。 */
  gitFile(id, rev, path2) {
    const dir = this.worldDir(id);
    try {
      return execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', 'show', `${rev}:${path2}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    } catch { return ''; }
  }

  /** 回滚为新提交：把工作区恢复到该提交（git checkout rev -- .）→ 立即提交（不重写历史）。 */
  gitRollback(id, rev) {
    const dir = this.worldDir(id);
    try {
      execFileSync('git', ['-C', dir, 'checkout', rev, '--', '.'], { encoding: 'utf8' });
      execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
      const out = execFileSync('git', ['-C', dir, '-c', 'user.name=Soliterra', '-c', 'user.email=soliterra@local',
        'commit', '-q', '-m', `rollback: 恢复到 ${rev}`], { encoding: 'utf8' });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.stderr || e.message).slice(0, 300) }; }
  }

  /** 未提交状态（git status --porcelain）。 */
  gitStatus(id) {
    const dir = this.worldDir(id);
    try {
      const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
      const files = out ? out.split('\n').map((l) => l.slice(3).trim()) : [];
      return { dirty: files.length, files: files.slice(0, 80) };
    } catch { return { dirty: 0, files: [] }; }
  }

  /** 手动提交（提交按钮在设置里；编辑退出只保存不提交）。 */
  gitCommit(id, message) {
    const dir = this.worldDir(id);
    try {
      execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
      const out = execFileSync('git', ['-C', dir, '-c', 'user.name=Soliterra', '-c', 'user.email=soliterra@local',
        'commit', '-q', '-m', message], { encoding: 'utf8' });
      return { ok: true, detail: out.trim() };
    } catch (e) {
      // 无改动时 commit 会以非零退出——不视为错误
      return { ok: true, detail: 'nothing to commit' };
    }
  }

  closeAll() {
    for (const w of this.watchers.values()) w.close();
    for (const i of this.indexes.values()) i.close();
  }
}

function firstLine(body) {
  if (!body) return '';
  return body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
}
function firstParagraph(body) {
  if (!body) return '';
  const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('&'));
  return lines.slice(0, 2).join(' ').slice(0, 120);
}
