// Soliterra 世界管理 —— 发现 / 创建 / 索引缓存 / 文件监听。
// 世界 = 一个 git 仓库目录；平台不预设任何内容目录，只管理 assets/ 与 .soliterra/。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import chokidar from 'chokidar';
import { WorldIndex, collectMarkdown } from './indexer.js';
import { parseEntry } from './parser.js';

export class Vault {
  constructor(worldsDir) {
    this.worldsDir = path.resolve(worldsDir);
    fs.mkdirSync(this.worldsDir, { recursive: true });
    this.indexes = new Map();   // worldId -> WorldIndex
    this.watchers = new Map();  // worldId -> chokidar watcher
  }

  /** 关停某世界的文件监听与索引（测试 / 退出清理用；幂等）。 */
  close(id) {
    const w = this.watchers.get(id);
    if (w) { try { w.close(); } catch { /* 已停 */ } this.watchers.delete(id); }
    const idx = this.indexes.get(id);
    if (idx) { try { idx.db?.close?.(); } catch { /* 已关 */ } this.indexes.delete(id); }
  }

  worldDir(id) {
    const dir = path.join(this.worldsDir, id);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(this.worldsDir + path.sep)) throw new Error('invalid world id');
    return resolved;
  }

  /** 世界的真实磁盘位置（符号链接世界返回真实目标；目录消失时退回拼接路径）。第 87 轮「位置」显示用。 */
  realDir(id) {
    const dir = this.worldDir(id);
    try { return fs.realpathSync(dir); } catch { return dir; }
  }

  /** 世界是否为库外文件夹的符号链接登记（第 88 轮：删除只摘链、改名连目标一起改）。 */
  isLinked(id) {
    try { return fs.lstatSync(this.worldDir(id)).isSymbolicLink(); } catch { return false; }
  }

  /** 根条目相对路径（第 88 轮约定）：README.md（介绍/元数据）优先；
   *  回落「世界名书」（`<世界名>.md`，第 89 轮迁入 books/ 后认 `books/<世界名>.md`）。 */
  rootEntryRel(id) {
    const idx = this.index(id);
    if (idx.entry('README.md')) return 'README.md';
    if (idx.entry(`${id}.md`)) return `${id}.md`;
    if (idx.entry(`books/${id}.md`)) return `books/${id}.md`;
    return null;
  }

  /** 世界信息（从根条目与统计读取）。 */
  worldInfo(id) {
    const dir = this.worldDir(id);
    const idx = this.index(id);
    const stats = idx.stats();
    const root = idx.entry(this.rootEntryRel(id) || '');
    let cover = root?.meta?.m?.[0] || null;
    // 封面可见性：assets 下直接可服务
    return {
      id,
      name: root?.title || id,
      subtitle: firstLine(root?.body) || '',
      cover,
      description: firstParagraph(root?.body) || '',
      dir: this.realDir(id),         // 本地存储位置（绝对路径；前端缩为 ~/… 显示）
      linked: this.isLinked(id),     // 库外文件夹登记（删除/改名为摘链/连改语义）
      rootRel: this.rootEntryRel(id),// 根条目（README.md / 世界名.md）
      stats,
    };
  }

  list() {
    const out = [];
    for (const it of fs.readdirSync(this.worldsDir, { withFileTypes: true })) {
      if (!it.isDirectory() && !it.isSymbolicLink()) continue;
      if (it.name.startsWith('.')) continue;
      if (this._unmanagedSet().has(it.name)) continue;   // 已「取消管理」（第 90 轮）
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
      if (rel === `books${path.sep}archives` || rel.startsWith(`books${path.sep}archives${path.sep}`)) return true;   // 条目归档区（第 90 轮）
      return rel.split(path.sep).some((seg) => seg === 'node_modules' || seg === '.soliterra' || seg === 'assets' || seg.startsWith('.'));
    };
    const w = chokidar.watch(dir, {
      ignored,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });
    w.on('error', (err) => console.error(`[watch:${id}]`, err.message));
    const idx = this.indexes.get(id);
    w.on('add', (f) => {
      if (!f.endsWith('.md')) return;
      idx.indexFile(path.relative(dir, f));
      // 归档还原场景（第 90 轮）：书 md 回来时配对目录已在（不触发 addDir）→ 补扫子树
      const d = f.replace(/\.md$/, '');
      const rp = path.relative(dir, f).replace(/\.md$/, '');
      try { if (fs.existsSync(d) && fs.statSync(d).isDirectory()) for (const g of collectMarkdown(d)) idx.indexFile(`${rp}/${g}`); } catch { /* 已消失 */ }
    });
    w.on('change', (f) => { if (f.endsWith('.md')) idx.indexFile(path.relative(dir, f)); });
    w.on('unlink', (f) => {
      if (!f.endsWith('.md')) return;
      const r = path.relative(dir, f);
      // 书归档（第 90 轮）：`X.md` 改名 `X.md.arc` → 整棵（md + X/ 子树）从索引隐藏
      if (fs.existsSync(`${f}.arc`)) idx.removePrefix(r.replace(/\.md$/, ''));
      idx.removeFile(r);
    });
    // 外部新建/删除**目录**（Finder/编辑器建书）——chokidar 对"watcher 启动后才出现的目录"的
    // 初始内容可能漏发 add（第 80 轮实测：顶层新目录里的 md 不被索引）→ 目录事件补扫/补删
    w.on('addDir', (d) => {
      try { for (const f of collectMarkdown(d)) idx.indexFile(path.relative(dir, f)); } catch { /* 已消失 */ }
    });
    w.on('unlinkDir', (d) => { idx.removePrefix(path.relative(dir, d)); });
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
    const targetDir = path.join(dir, 'assets', 'images');   // 正文图片之家（第 89 轮规范）
    fs.mkdirSync(targetDir, { recursive: true });
    let rel = `assets/images/${base}${ext}`;
    let i = 2;
    while (fs.existsSync(path.join(dir, rel))) { rel = `assets/images/${base}-${i}${ext}`; i++; }
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

  /** 世界仓库初始化（create / adopt / 导入共用）：非仓库目录 → `git init` + **main 分支** + 唯一自动提交。
   *  已是仓库 → 一切不动（返回 false）。git 不可用 → 静默（世界仍可读写）。 */
  _gitInitCommit(dir, message) {
    if (fs.existsSync(path.join(dir, '.git'))) return false;
    try {
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });            // git ≥ 2.28
      } catch {
        execFileSync('git', ['init', '-q'], { cwd: dir });                          // 老 git：未出生分支先指向 main
        execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir });
      }
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=Soliterra', '-c', 'user.email=soliterra@local',
        'commit', '-q', '-m', message], { cwd: dir });
      return true;
    } catch { return false; }
  }

  /** 世界文件夹初始化（create / adopt 共用，第 88 轮）：
   *  assets/ 确保存在；根条目 = README.md（介绍与 & 元数据；**已存在则只前置缺失的 & 行，绝不改正文**）；
   *  时间线事件 → `时间线/NN-标题.md`；`.gitignore` 补 `.soliterra/`；非 git 仓库 → init + 唯一自动提交。 */
  _initWorldFolder(dir, { name, intro = '', timeline = '', coverRel = '', calendar = '' }) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'books'), { recursive: true });   // 书籍容器（第 89 轮规范）
    const calLine = calendar ? `<!-- calendar: ${calendar} -->` : '';
    const tlLines = String(timeline || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const eventLines = tlLines.filter((x) => /&s\s/.test(x));
    const plainLines = tlLines.filter((x) => !/&s\s/.test(x));
    const readmeAbs = path.join(dir, 'README.md');
    if (fs.existsSync(readmeAbs)) {
      // 既有 README：补缺失的 & 行（& 行是世界元数据通道；正文一字不动）
      let t = fs.readFileSync(readmeAbs, 'utf8');
      const add = [];
      if (!/^&n\s/m.test(t)) add.push(`&n ${name}`);
      if (coverRel && !/^&m\s/m.test(t)) add.push(`&m ${coverRel}`);
      if (add.length) fs.writeFileSync(readmeAbs, `${add.join('\n')}\n${t}`, 'utf8');
    } else {
      const meta = [`&n ${name}`, coverRel ? `&m ${coverRel}` : ''].filter(Boolean).join('\n');
      const body = [`# ${name}`, '', intro || '', calLine && ['', calLine], '', plainLines.join('\n')].flat().filter((x) => x !== undefined).join('\n');
      fs.writeFileSync(readmeAbs, `${meta}\n\n${body}\n`, 'utf8');
    }
    if (eventLines.length) {
      // 时间线书（第 89 轮：books/时间线/ + 配对 `时间线.md`——书籍一律成对住 books/ 下）
      const tlDir = path.join(dir, 'books', '时间线');
      fs.mkdirSync(tlDir, { recursive: true });
      const tlMd = path.join(dir, 'books', '时间线.md');
      if (!fs.existsSync(tlMd)) fs.writeFileSync(tlMd, `&n 时间线\n\n# 时间线\n\n世界大事记（自动生成，可自由整理）。\n`, 'utf8');
      eventLines.forEach((line, i) => {
        // 标题 = 行内元数据段之外的裸文本；无裸文本则取 &f 首词
        const fval = (line.match(/&f\s+([^&]*)/) || [])[1]?.trim() || '';
        const rest = line.replace(/&[a-z]\s+[^&]*/g, '').replace(/&[a-z]\b/g, '').trim();
        const title = (rest || fval.split(/\s+/)[0] || `事件${i + 1}`).replace(/\s+/g, '');
        const safeTitle = String(title).replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || `事件${i + 1}`;
        const idx2 = String(i + 1).padStart(2, '0');
        fs.writeFileSync(path.join(tlDir, `${idx2}-${safeTitle}.md`), `${line}\n\n# ${safeTitle}\n`, 'utf8');
      });
    }
    // .gitignore：无则写；已有则缺 .soliterra 时补一行（附加操作，不动原内容）
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.soliterra/\n', 'utf8');
    else {
      const t = fs.readFileSync(gi, 'utf8');
      if (!/^\.soliterra\/?\s*$/m.test(t)) fs.writeFileSync(gi, `${t.replace(/\n?$/, '\n')}.soliterra/\n`, 'utf8');
    }
    // git：仅当目录还不是仓库时 init（**main 分支**）+ 唯一自动提交（已是仓库 → 一切不动，由用户手动提交）
    this._gitInitCommit(dir, `init: 创建世界 ${name}`);
  }

  /** 创建世界（库里新建文件夹）：目录 + README.md 根条目 + assets + .gitignore + git init。 */
  create({ name, subtitle = '', timeline = '', cover = '', calendar = '' }) {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('invalid world name');
    const dir = path.join(this.worldsDir, name);
    if (fs.existsSync(dir)) throw new Error('world already exists');
    this._remanage(name);
    this._initWorldFolder(dir, { name, intro: subtitle, timeline, coverRel: cover, calendar });
    return this.worldInfo(name);
  }

  /** 世界库的真实路径（自身可能经符号链接挂载；比较用）。 */
  _libReal() {
    try { return fs.realpathSync(this.worldsDir); } catch { return this.worldsDir; }
  }

  /** 校验候选世界文件夹（adopt / inspect 共用）：存在、是目录、非库根/非库的父级；返回 basename。 */
  _adoptTarget(dir) {
    const abs = path.resolve(String(dir || ''));
    if (!dir || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('文件夹不存在: ' + dir);
    const real = fs.realpathSync(abs);
    const libReal = this._libReal();
    if (real === libReal) throw new Error('不能把世界库本身作为世界');
    if ((libReal + path.sep).startsWith(real + path.sep)) throw new Error('不能选择世界库的上级文件夹');
    const name = path.basename(real) || path.basename(abs);
    if (!name) throw new Error('无法从路径取世界名');
    return { abs, real, name };
  }

  /** 登记检查：库内直接子文件夹 → 原地（无需链接）；其余（库外/库内嵌套）→ 世界库内建符号链接。
   *  同名冲突 → 报错；同目标链接已存在 → 复用。返回 { id, link(可空) }。 */
  _registerWorld(abs, real, name) {
    const direct = path.dirname(real) === this._libReal();
    if (direct) return { id: path.basename(real), link: null };
    const linkPath = path.join(this.worldsDir, name);
    if (fs.existsSync(linkPath) || fs.existsSync(linkPath.replace(/\/$/, ''))) {
      const cur = (() => { try { return fs.realpathSync(linkPath); } catch { return null; } })();
      if (cur === real) return { id: name, link: linkPath };   // 同目标已登记 → 复用
      throw new Error(`世界库中已有同名条目「${name}」，请改名或选择其他文件夹`);
    }
    fs.symlinkSync(real, linkPath, 'dir');
    return { id: name, link: linkPath };
  }

  /** 采纳本地文件夹为世界（第 88 轮）：就地接入（不复制）；文件夹名 = 世界名；
   *  介绍/元数据 → README.md；封面图片 → 复制进 `assets/`（已在文件夹内则只记相对路径）。 */
  adoptFolder({ dir, intro = '', coverPath = '', calendar = '', timeline = '' }) {
    const { abs, real, name } = this._adoptTarget(dir);
    const { id } = this._registerWorld(abs, real, name);
    this._remanage(id);   // 重新采纳 = 恢复管理（第 90 轮）
    const coverRel = coverPath ? this._bringCoverIn(real, coverPath) : '';
    this._initWorldFolder(real, { name, intro, timeline, coverRel, calendar });
    this.indexes.delete(id);   // 重新索引（可能是已登记世界的再采纳）
    return this.worldInfo(id);
  }

  /** 把封面图片放进世界（返回相对路径）：已在世界内 → 原样相对；否则复制到 assets/（重名自动加序号）。 */
  _bringCoverIn(real, coverPath) {
    const src = path.resolve(String(coverPath));
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('封面图片不存在: ' + coverPath);
    const srcReal = fs.realpathSync(src);
    if (srcReal.startsWith(real + path.sep)) return path.relative(real, srcReal).replace(/\\/g, '/');
    const ext = path.extname(src).toLowerCase();
    const stem = path.basename(src, path.extname(src));
    fs.mkdirSync(path.join(real, 'assets', 'covers'), { recursive: true });   // 封面之家（第 89 轮规范）
    let rel = `assets/covers/${path.basename(src)}`;
    let n = 1;
    while (fs.existsSync(path.join(real, rel))) {
      // 同名文件已在：同大小视为同一张 → 复用；否则加序号
      try { if (fs.statSync(path.join(real, rel)).size === fs.statSync(src).size) return rel; } catch {}
      rel = `assets/covers/${stem}-${n++}${ext}`;
    }
    fs.copyFileSync(src, path.join(real, rel));
    return rel;
  }

  /** 采纳前检查（向导第一步用）：文件夹信息 + 冲突预判，不落盘。 */
  inspectFolder(dir) {
    const { real, name } = this._adoptTarget(dir);
    const direct = path.dirname(real) === this._libReal();
    const linkPath = path.join(this.worldsDir, name);
    if (!direct && (fs.existsSync(linkPath))) {
      const cur = (() => { try { return fs.realpathSync(linkPath); } catch { return null; } })();
      if (cur !== real) throw new Error(`世界库中已有同名条目「${name}」，请改名或选择其他文件夹`);
    }
    const walk = (d, cb) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p, cb); else cb(p);
      }
    };
    let mdCount = 0;
    try { walk(real, (p) => { if (p.endsWith('.md')) mdCount++; }); } catch { /* 不可读 */ }
    return {
      path: real,
      name,
      insideLibrary: direct,
      mdCount,
      hasReadme: fs.existsSync(path.join(real, 'README.md')),
      hasGit: fs.existsSync(path.join(real, '.git')),
      alreadyRegistered: direct || (() => { try { return fs.realpathSync(linkPath) === real; } catch { return false; } })(),
    };
  }

  /** 世界级操作（§1.1）：重命名 / 复制 / 删除（移入 worlds/.trash-<ts>/，list() 跳过点目录）。
   *  第 88 轮：链接世界（库外文件夹登记）——改名 = 连真实文件夹一起改 + 重建链接；删除 = 仅摘链（文件夹保留原位）。 */
  _worldNameCheck(name) {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('invalid world name');
    const dst = path.join(this.worldsDir, name);
    if (fs.existsSync(dst)) throw new Error('已存在同名世界: ' + name);
    return dst;
  }

  /** 根条目 `&n` 同步（README.md 优先；历史世界回落 `<旧名>.md`）。 */
  _syncRootName(dir, oldBase, newName) {
    const readme = path.join(dir, 'README.md');
    const legacy = path.join(dir, `${oldBase}.md`);
    const target = fs.existsSync(readme) ? readme : (fs.existsSync(legacy) ? legacy : null);
    if (!target) return;
    try {
      let t = fs.readFileSync(target, 'utf8');
      if (/^&n\s/m.test(t)) t = t.replace(/^&n\s.*$/m, `&n ${newName}`);
      else t = `&n ${newName}\n` + t;
      fs.writeFileSync(target, t, 'utf8');
    } catch { /* 根条目同步失败不影响改名 */ }
  }

  /** 历史根条目（`<旧名>.md`）跟随改名；README.md 为根时不动。 */
  _renameLegacyRoot(dir, oldId, newName) {
    if (fs.existsSync(path.join(dir, 'README.md'))) return;
    const legacy = path.join(dir, `${oldId}.md`);
    if (!fs.existsSync(legacy)) return;
    try { fs.renameSync(legacy, path.join(dir, `${newName}.md`)); } catch { /* 保留原名 */ }
  }

  renameWorld(id, newName) {
    const from = path.join(this.worldsDir, id);
    if (!fs.existsSync(from)) throw new Error('world not found: ' + id);
    if (this.isLinked(id)) {
      // 链接世界：改真实文件夹（同父目录）→ 摘旧链 → 建新链；&n 同步
      const realOld = fs.realpathSync(from);
      const parent = path.dirname(realOld);
      const realNew = path.join(parent, newName);
      if (fs.existsSync(realNew)) throw new Error(`目标文件夹已存在：${realNew}`);
      if (fs.existsSync(path.join(this.worldsDir, newName))) throw new Error('已存在同名世界: ' + newName);
      fs.renameSync(realOld, realNew);
      fs.unlinkSync(from);
      fs.symlinkSync(realNew, path.join(this.worldsDir, newName), 'dir');
      this._syncRootName(realNew, id, newName);
      this._renameLegacyRoot(realNew, id, newName);
      this.indexes.delete(id);
      const w = this.watchers.get(id);
      if (w) { try { w.close(); } catch {} this.watchers.delete(id); }
      return this.worldInfo(newName);
    }
    const to = this._worldNameCheck(newName);
    fs.renameSync(from, to);
    // 改名后根条目 &n 同步（README.md 优先）；历史世界 `<旧名>.md` 文件本身也改名
    this._syncRootName(to, id, newName);
    this._renameLegacyRoot(to, id, newName);
    this.indexes.delete(id);
    const w = this.watchers.get(id);
    if (w) { try { w.close(); } catch {} this.watchers.delete(id); }
    return this.worldInfo(newName);
  }

  duplicateWorld(id, newName) {
    const from = path.join(this.worldsDir, id);
    if (!fs.existsSync(from)) throw new Error('world not found: ' + id);
    const to = this._worldNameCheck(newName);
    fs.cpSync(this.realDir(id), to, { recursive: true });   // 链接世界 → 复制真实内容（副本是库内真实目录）
    this._syncRootName(to, id, newName);
    this._renameLegacyRoot(to, id, newName);
    return this.worldInfo(newName);
  }

  /** 库内忽略表（第 90 轮「取消管理」）：`worldsDir/.unmanaged.json`——仅记录不管理的名字，
   *  本地文件夹一律原地保留；再次「新建世界」选中该文件夹（adopt）即恢复管理。 */
  _unmanagedSet() {
    if (!this._unmanaged) {
      try { this._unmanaged = new Set(JSON.parse(fs.readFileSync(path.join(this.worldsDir, '.unmanaged.json'), 'utf8')).ids || []); }
      catch { this._unmanaged = new Set(); }
    }
    return this._unmanaged;
  }

  _saveUnmanaged() {
    try { fs.writeFileSync(path.join(this.worldsDir, '.unmanaged.json'), JSON.stringify({ ids: [...this._unmanagedSet()].sort() }, null, 2), 'utf8'); }
    catch { /* 忽略表写入失败不阻断 */ }
  }

  /** 恢复管理（adopt / create 时调用）：从忽略表移除。 */
  _remanage(id) {
    if (this._unmanagedSet().delete(id)) this._saveUnmanaged();
  }

  /** 取消管理（第 90 轮）：**不删除任何本地文件**——
   *  库外链接世界 = 摘链；库内世界 = 记入忽略表（list() 跳过）。 */
  unmanageWorld(id) {
    const entry = this.worldDir(id);
    if (!fs.existsSync(entry)) throw new Error('world not found: ' + id);
    let mode;
    let target = null;
    if (this.isLinked(id)) {
      target = (() => { try { return fs.realpathSync(entry); } catch { return null; } })();
      fs.unlinkSync(entry);
      mode = 'unlinked';
    } else {
      this._unmanagedSet().add(id);
      this._saveUnmanaged();
      mode = 'ignored';
    }
    this.indexes.delete(id);
    const w = this.watchers.get(id);
    if (w) { try { w.close(); } catch {} this.watchers.delete(id); }
    return { mode, id, untouched: target || entry };
  }

  /** 书籍归档（第 90 轮）：`books/书.md` → `books/书.md.arc`（平台即不显示此书，配对目录原样保留）。
   *  纯目录节点（无配对 md）→ 写 `书.md.arc` 标记；还原时按标记注释删除。 */
  archiveBook(id, rel) {
    const dir = this.worldDir(id);
    const base = String(rel).replace(/\\/g, '/').replace(/\/$/, '').replace(/\.md$/i, '').replace(/\.arc$/i, '');
    if (!base) throw new Error('invalid path');
    const mdAbs = this._safe(dir, `${base}.md`);
    const arcAbs = this._safe(dir, `${base}.md.arc`);
    if (fs.existsSync(arcAbs)) throw new Error('已是归档状态：' + base);
    if (fs.existsSync(mdAbs)) fs.renameSync(mdAbs, arcAbs);
    else fs.writeFileSync(arcAbs, `&n ${path.basename(base)}\n<!-- archived: folder-only -->\n`, 'utf8');
    const idx = this.index(id);
    idx.removeFile(`${base}.md`);
    const bookDir = this._safe(dir, base);
    if (fs.existsSync(bookDir)) idx.removePrefix(base);
    return { archived: `${base}.md.arc`, rel: base };
  }

  /** 取消归档（书）：`.md.arc` → `.md` 并重扫其配对目录；标记文件（纯目录节点）直接删除。 */
  unarchiveBook(id, rel) {
    const dir = this.worldDir(id);
    const base = String(rel).replace(/\\/g, '/').replace(/\/$/, '').replace(/\.md(\.arc)?$/i, '');
    if (!base) throw new Error('invalid path');
    const arcAbs = this._safe(dir, `${base}.md.arc`);
    const mdAbs = this._safe(dir, `${base}.md`);
    if (!fs.existsSync(arcAbs)) throw new Error('未归档：' + base);
    const text = fs.readFileSync(arcAbs, 'utf8');
    if (/^<!-- archived: folder-only -->$/m.test(text)) {
      fs.unlinkSync(arcAbs);                       // 纯目录节点：标记即全部
    } else {
      if (fs.existsSync(mdAbs)) throw new Error('目标已存在同名条目：' + base + '.md');
      fs.renameSync(arcAbs, mdAbs);
    }
    const idx = this.index(id);
    if (fs.existsSync(mdAbs)) idx.indexFile(`${base}.md`);
    const bookDir = this._safe(dir, base);
    if (fs.existsSync(bookDir)) for (const f of collectMarkdown(bookDir)) idx.indexFile(`${base}/${f}`);
    return { restored: base };
  }

  /** 条目归档（第 90 轮）：条目（+ 同名文件夹）→ `books/archives/<原路径去掉 books/ 前缀>`；
   *  条目元数据写入 `&x <归档前相对路径>`（还原依据）。 */
  archiveEntry(id, rel) {
    const dir = this.worldDir(id);
    const clean = String(rel).replace(/\\/g, '/').replace(/\/$/, '');
    const mdRel = /\.md$/i.test(clean) ? clean : `${clean}.md`;
    const src = this._safe(dir, mdRel);
    if (!fs.existsSync(src)) throw new Error('条目不存在: ' + rel);
    if (mdRel.startsWith('books/archives/')) throw new Error('该条目已在归档区');
    const inner = mdRel.startsWith('books/') ? mdRel.slice('books/'.length) : mdRel;
    let destRel = `books/archives/${inner}`;
    let n = 1;
    while (fs.existsSync(path.join(dir, destRel)) || fs.existsSync(path.join(dir, destRel.replace(/\.md$/i, '')))) {
      destRel = `books/archives/${inner.replace(/\.md$/i, `-${n++}.md`)}`;
    }
    let text = fs.readFileSync(src, 'utf8');
    if (!/^&x\s/m.test(text)) text = `&x ${mdRel}\n${text}`;   // 归档状态 + 归档前位置
    fs.writeFileSync(src, text, 'utf8');
    const destAbs = path.join(dir, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(src, destAbs);
    const srcDir = this._safe(dir, mdRel.replace(/\.md$/i, ''));
    const destDir = path.join(dir, destRel.replace(/\.md$/i, ''));
    if (fs.existsSync(srcDir)) fs.renameSync(srcDir, destDir);
    const idx = this.index(id);
    idx.removeFile(mdRel);
    idx.removePrefix(mdRel.replace(/\.md$/i, ''));
    return { archived: destRel, orig: mdRel };
  }

  /** 取消条目归档：按 `&x` 记录的原路径搬回并删掉 `&x` 行；原位置被占 → 报错不硬塞。 */
  unarchiveEntry(id, rel) {
    const dir = this.worldDir(id);
    const clean = String(rel).replace(/\\/g, '/').replace(/\/$/, '');
    const arcRel = /\.md$/i.test(clean) ? clean : `${clean}.md`;
    const src = this._safe(dir, arcRel);
    if (!fs.existsSync(src)) throw new Error('归档条目不存在: ' + rel);
    let text = fs.readFileSync(src, 'utf8');
    const m = text.match(/^&x\s+(\S+)\s*$/m);
    if (!m) throw new Error('缺少 &x 归档前位置，无法还原');
    const origRel = m[1];
    const destAbs = this._safe(dir, origRel);
    if (fs.existsSync(destAbs)) throw new Error('原位置已有同名条目：' + origRel);
    text = text.replace(/^&x\s+\S+\s*\n/m, '');
    fs.writeFileSync(src, text, 'utf8');
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(src, destAbs);
    const srcDir = this._safe(dir, arcRel.replace(/\.md$/i, ''));
    const destDir = this._safe(dir, origRel.replace(/\.md$/i, ''));
    if (fs.existsSync(srcDir)) fs.renameSync(srcDir, destDir);
    const idx = this.index(id);
    idx.indexFile(origRel);
    if (fs.existsSync(destDir)) for (const f of collectMarkdown(destDir)) idx.indexFile(`${origRel.replace(/\.md$/i, '')}/${f}`);
    this._pruneEmptyArchives(dir);
    return { restored: origRel };
  }

  /** 归档分发（第 90 轮）：顶层书（`书.md` / `books/书.md`，可无扩展）→ 书归档；更深 → 条目归档。 */
  archiveNode(id, rel) {
    const clean = String(rel).replace(/\\/g, '/').replace(/\/$/, '').replace(/\.md$/i, '');
    const segs = clean.split('/').filter(Boolean);
    const isBook = segs.length === 1 || (segs.length === 2 && segs[0] === 'books');
    return isBook ? this.archiveBook(id, clean) : this.archiveEntry(id, clean);
  }

  unarchiveNode(id, rel) {
    const clean = String(rel).replace(/\\/g, '/').replace(/\/$/, '').replace(/\.md$/i, '').replace(/\.arc$/i, '');
    const segs = clean.split('/').filter(Boolean);
    const isBook = segs.length === 1 || (segs.length === 2 && segs[0] === 'books');
    return isBook ? this.unarchiveBook(id, clean) : this.unarchiveEntry(id, clean);
  }

  /** 清掉归档区里的空目录（还原搬走后；`books/archives` 自身空也移除，下次归档自动重创建）。 */
  _pruneEmptyArchives(dir) {
    const root = path.join(dir, 'books', 'archives');
    const prune = (abs) => {
      let items = [];
      try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { return false; }
      for (const it of items) if (it.isDirectory()) prune(path.join(abs, it.name));
      let left = [];
      try { left = fs.readdirSync(abs); } catch { return false; }   // 子目录剪完后重数
      if (!left.length) { try { fs.rmdirSync(abs); return true; } catch { return false; } }
      return false;
    };
    try { if (fs.existsSync(root)) prune(root); } catch { /* 尽力而为 */ }
  }

  /** 归档清单（第 90 轮，书籍面板「归档」视图）：书 = `books/*.md.arc`；条目 = `books/archives/**`（读 `&x`）。 */
  listArchives(id) {
    const dir = this.worldDir(id);
    const books = [];
    const entries = [];
    const titleOf = (abs, fallback) => {
      try { return parseEntry(path.relative(dir, abs), fs.readFileSync(abs, 'utf8')).title || fallback; }
      catch { return fallback; }
    };
    try {
      for (const e of fs.readdirSync(path.join(dir, 'books'), { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith('.md.arc')) continue;
        const rel = `books/${e.name.replace(/\.arc$/, '')}`;
        books.push({ kind: 'book', rel, title: titleOf(path.join(dir, 'books', e.name), e.name.replace(/\.md\.arc$/, '')) });
      }
    } catch { /* 无 books/ */ }
    const walk = (abs, prefix) => {
      let items = [];
      try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (it.name.startsWith('.')) continue;
        const r = prefix ? `${prefix}/${it.name}` : it.name;
        if (it.isDirectory()) walk(path.join(abs, it.name), r);
        else if (it.name.endsWith('.md')) {
          const text = (() => { try { return fs.readFileSync(path.join(abs, it.name), 'utf8'); } catch { return ''; } })();
          const mx = text.match(/^&x\s+(\S+)\s*$/m);
          if (!mx) continue;   // 只列归档根（带 &x）；随迁的子树文件随根一起还原
          entries.push({ kind: 'entry', rel: `books/archives/${r}`, title: titleOf(path.join(abs, it.name), it.name.replace(/\.md$/, '')), orig: mx[1] });
        }
      }
    };
    walk(path.join(dir, 'books', 'archives'), '');
    return { books, entries };
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
    fs.mkdirSync(path.join(dest, 'assets', 'images'), { recursive: true });
    walk(srcAbs, (abs) => {
      const ext = path.extname(abs).toLowerCase();
      if (!IMG.has(ext)) return;
      const base = path.basename(abs);
      const stem = base.replace(/\.[^.]+$/, '');
      let saved = `assets/images/${base}`;
      let n = 1;
      while (fs.existsSync(path.join(dest, saved))) saved = `assets/images/${path.basename(base, ext)}-${n++}${ext}`;
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
    // 5) git init（同 create：main 分支）
    fs.writeFileSync(path.join(dest, '.gitignore'), '.soliterra/\n', 'utf8');
    this._gitInitCommit(dest, `init: 从 Obsidian 导入 ${name}（${count} 条目，${imgCount} 图片）`);
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

  /** 重命名：md 与同名目录成对改名；**纯目录节点**（无同名 md，如「黄金时代/」）也支持——目录改名 + 配对 md（若有）一并。
   *  rel 为 md 路径（'A/B.md'）或目录路径（'A/B'）。 */
  renameEntry(id, rel, newName) {
    if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error('invalid name');
    const dir = this.worldDir(id);
    const clean = rel.replace(/\/$/, '');
    const from = this._safe(dir, clean);
    if (!fs.existsSync(from)) throw new Error('source not found: ' + rel);
    // ── 纯目录节点（第 80 轮）：子文件路径全部变化 → 子树重建；同层配对 md（若有）一并改名
    if (!/\.md$/i.test(clean) && fs.statSync(from).isDirectory()) {
      const parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
      const baseName = clean.slice(clean.lastIndexOf('/') + 1);
      const newRelDir = (parent ? parent + '/' : '') + newName;
      const to = this._safe(dir, newRelDir);
      if (fs.existsSync(to)) throw new Error('已存在同名节点: ' + newRelDir);
      fs.renameSync(from, to);
      const idx = this.index(id);
      const mdFromRel = (parent ? parent + '/' : '') + `${baseName}.md`;
      const mdFrom = this._safe(dir, mdFromRel);
      if (fs.existsSync(mdFrom)) {
        const mdToRel = (parent ? parent + '/' : '') + `${newName}.md`;
        fs.renameSync(mdFrom, this._safe(dir, mdToRel));
        try {
          let text = fs.readFileSync(this._safe(dir, mdToRel), 'utf8');
          if (/^&n\s/m.test(text)) text = text.replace(/^&n\s.*$/m, `&n ${newName}`);
          else text = `&n ${newName}\n` + text;
          fs.writeFileSync(this._safe(dir, mdToRel), text, 'utf8');
        } catch { /* 内容改写失败不影响改名本身 */ }
        idx.removeFile(mdFromRel);
        idx.indexFile(mdToRel);
      }
      const walk = (abs) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
          if (ent.isDirectory()) walk(path.join(abs, ent.name));
          else if (ent.name.endsWith('.md')) idx.indexFile(path.relative(dir, path.join(abs, ent.name)));
        }
      };
      walk(to);
      idx.removePrefix(clean);   // 旧路径行同步清掉（否则等 watcher 300ms+ 的 unlink，期间树里新旧并存）
      return { path: newRelDir };
    }
    const base = clean.replace(/\.md$/i, '');
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
    // 目录内子文件路径都变了 → 子树重建（旧路径行同步清掉，不等 watcher 的 unlink）
    if (fs.existsSync(dirTo)) {
      const idx = this.index(id);
      const walk = (abs) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
          if (ent.isDirectory()) walk(path.join(abs, ent.name));
          else if (ent.name.endsWith('.md')) idx.indexFile(path.relative(dir, path.join(abs, ent.name)));
        }
      };
      walk(dirTo);
      idx.removePrefix(base);
    }
    return { path: newRel.replace(/\\/g, '/') };
  }

  /** 删除：md + 同名目录（若有）整体移入 .soliterra/trash-<ts>/（不进 git）；**纯目录节点**也支持（第 80 轮）。 */
  deleteEntry(id, rel) {
    const dir = this.worldDir(id);
    const clean = rel.replace(/\/$/, '');
    const from = this._safe(dir, clean);
    if (!fs.existsSync(from)) throw new Error('source not found: ' + rel);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // ── 纯目录节点：目录（+ 同层配对 md 若有）整体入回收站，子树从索引移除
    if (!/\.md$/i.test(clean) && fs.statSync(from).isDirectory()) {
      const parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
      const baseName = clean.slice(clean.lastIndexOf('/') + 1);
      const trashDir = path.join(dir, '.soliterra', `trash-${ts}`, parent);
      fs.mkdirSync(trashDir, { recursive: true });
      const movedDir = path.join(trashDir, baseName);
      fs.renameSync(from, movedDir);
      const mdRel = (parent ? parent + '/' : '') + `${baseName}.md`;
      const mdAbs = this._safe(dir, mdRel);
      if (fs.existsSync(mdAbs)) { fs.renameSync(mdAbs, path.join(trashDir, `${baseName}.md`)); }
      const idx = this.index(id);
      const walk = (abs, prefix) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
          const r2 = prefix ? `${prefix}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(path.join(abs, ent.name), r2);
          else if (ent.name.endsWith('.md')) idx.removeFile(r2);
        }
      };
      walk(movedDir, parent ? `${parent}/${baseName}` : baseName);
      if (fs.existsSync(path.join(trashDir, `${baseName}.md`))) idx.removeFile(mdRel);
      return { trashed: path.relative(dir, movedDir).replace(/\\/g, '/') };
    }
    const trash = path.join(dir, '.soliterra', `trash-${ts}`, path.dirname(clean));
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(from, path.join(trash, path.basename(from)));
    const base = clean.replace(/\.md$/i, '');
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
