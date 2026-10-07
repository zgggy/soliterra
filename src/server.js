#!/usr/bin/env node
// Soliterra 本地服务 —— `node server.js [worldsDir]` 或 `npx soliterra [worldsDir]`
// 设计：平台设计方案.md §七。单进程：REST + 静态 + 文件监听。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Vault } from './lib/vault.js';
import { renderEntry, renderFragment, sectionOf } from './lib/render.js';
import { parseEntry } from './lib/parser.js';
import { scan, apply as applyTool, lint, scanDrift, scanImages, scanRegex, scanDuplicates, scanOnboard, scanStructure, applyStructure, scanSymbols, scanCover } from './lib/tools.js';
import { buildSite } from './lib/publish.js';
import { pickFolder, pickImage } from './lib/picker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');   // 项目根（src/ 的上级）

/** 世界库目录解析（优先级从高到低）：
 *  ① CLI 参数  node server.js <dir>
 *  ② 环境变量  SOLITERRA_WORLDS=<dir>
 *  ③ soliterra.config.json 的 worldsDir（项目根或 src/ 下；相对路径按项目根解析）
 *  ④ 默认 <项目根>/src/worlds
 *  世界库独立于项目目录（世界观内容与本项目分开放，仓库保持纯净）。 */
function resolveWorldsDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (process.env.SOLITERRA_WORLDS) return path.resolve(process.env.SOLITERRA_WORLDS);
  for (const cfgPath of [path.join(projectRoot, 'soliterra.config.json'), path.join(__dirname, 'soliterra.config.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.worldsDir) return path.resolve(projectRoot, cfg.worldsDir);
    } catch {}
  }
  return path.join(__dirname, 'worlds');
}
const worldsDir = resolveWorldsDir();
const PORT = Number(process.env.PORT || 4747);

const vault = new Vault(worldsDir);
const app = Fastify({ logger: false });

// ---------- 静态服务（public/，零依赖） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
/** 第 105 轮：全异步静态服务——原 readFileSync 在图片密集世界会阻塞事件循环
 *  （含正在打字的自动保存）；stat/read 都走 promises，Fastify 对 async handler 的 reply.send 无时序问题。 */
async function serveStatic(reply, abs) {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) { reply.code(404).send('not found'); return; }
    reply.header('content-type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    reply.header('cache-control', 'no-cache');   // 本地开发：总是重新验证
    const buf = await fs.promises.readFile(abs);
    reply.send(buf);
  } catch { reply.code(404).send('not found'); }
}

app.get('/', async (req, reply) => { await serveStatic(reply, path.join(__dirname, 'public', 'index.html')); });
app.get('/css/*', async (req, reply) => { await serveStatic(reply, path.join(__dirname, 'public', 'css', req.params['*'])); });
app.get('/js/*', async (req, reply) => { await serveStatic(reply, path.join(__dirname, 'public', 'js', req.params['*'])); });
app.get('/locales/*', async (req, reply) => { await serveStatic(reply, path.join(__dirname, 'locales', req.params['*'])); });
// 共享纯函数模块（shared/：symbols/date——前后端同源单点真相；第 95 轮）
app.get('/shared/*', async (req, reply) => { await serveStatic(reply, path.join(__dirname, 'shared', req.params['*'])); });

// 世界的 assets（封面、图片）
app.get('/w/:id/assets/*', async (req, reply) => {
  try {
    const abs = path.join(vault.worldDir(req.params.id), 'assets', req.params['*']);
    await serveStatic(reply, abs);
  } catch { reply.code(404).send('not found'); }
});

// 世界文件兜底：接受整段编码路径（assets%2F... 形式，前端 enc() 全编码）；防目录穿越、屏蔽点文件
app.get('/w/:id/*', async (req, reply) => {
  try {
    const rel = String(req.params['*'] || '');
    if (!rel || rel.split('/').some((s) => s.startsWith('.'))) { reply.code(404).send('not found'); return; }
    const dir = vault.worldDir(req.params.id);
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) { reply.code(404).send('not found'); return; }
    await serveStatic(reply, abs);
  } catch { reply.code(404).send('not found'); }
});

// ---------- API ----------
app.get('/api/worlds', () => vault.list());

// 平台元信息（第 87 轮）：世界库根 + 家目录——前端用于「位置」显示（~/… 缩写）与新建世界目标预览
app.get('/api/meta', () => ({ worldsDir, home: os.homedir() }));

// locales 自动注册（§15.5：启动时扫描——新语言 = 丢一个 json 进 locales/）
app.get('/api/locales', () => {
  try {
    const dir = path.join(__dirname, 'locales');
    const files = fs.readdirSync(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => {
      const tag = f.replace(/\.json$/, '');
      let label = tag;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j['lang.name']) label = j['lang.name'];
      } catch {}
      return { tag, label };
    });
  } catch { return [{ tag: 'zh-CN', label: '中文' }, { tag: 'en', label: 'English' }]; }
});

// 世界级操作（§1.1：重命名/复制/删除——删除移入 worlds/.trash-<ts>/）
app.post('/api/worlds/rename', (req, reply) => {
  try { return { ok: true, ...vault.renameWorld(req.body?.id, (req.body?.newName || '').trim()) }; }
  catch (e) { reply.code(400).send({ error: e.message }); }
});
app.post('/api/worlds/duplicate', (req, reply) => {
  try { return { ok: true, ...vault.duplicateWorld(req.body?.id, (req.body?.newName || '').trim()) }; }
  catch (e) { reply.code(400).send({ error: e.message }); }
});
// 取消管理（第 90 轮）：世界卡不再删除本地文件夹——库内世界进忽略表、库外链接世界摘链
app.post('/api/worlds/unmanage', (req, reply) => {
  try {
    const { id, confirm } = req.body || {};
    if (confirm !== id) return reply.code(400).send({ error: 'confirm 须与世界名一致' });
    return { ok: true, ...vault.unmanageWorld(id) };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 在系统文件管理器中定位世界目录（第 87 轮；仅本机 UI 用——服务只监听 127.0.0.1）
app.post('/api/worlds/reveal', (req, reply) => {
  try {
    const id = String(req.body?.id || '');
    if (!id) throw new Error('world id required');
    const dir = vault.realDir(id);
    if (!fs.existsSync(dir)) throw new Error('world not found: ' + id);
    if (process.platform === 'darwin') execFileSync('open', ['-R', dir]);
    else if (process.platform === 'win32') execFileSync('explorer', [dir]);
    else execFileSync('xdg-open', [dir]);
    return { ok: true, dir };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// Obsidian 导入（§15.6）
app.post('/api/worlds/import', async (req, reply) => {
  try {
    const { path: src, name } = req.body || {};
    return await vault.importObsidian({ src, name: (name || '').trim() });
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 原生选择器（第 88 轮）：服务端弹系统对话框返回绝对路径（浏览器拿不到本地路径）。
// 自动化测试桩：SOLITERRA_PICK_STUB_FOLDER / SOLITERRA_PICK_STUB_FILE 设置后跳过对话框直接返回。
app.post('/api/pick/folder', async (req, reply) => {
  try {
    const stub = process.env.SOLITERRA_PICK_STUB_FOLDER;
    if (stub) return { ok: true, path: stub };
    const r = await pickFolder({ prompt: '选择世界文件夹', defaultPath: req.body?.default || worldsDir });
    return r.canceled ? { ok: false, canceled: true } : { ok: true, path: r.path };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

const PICK_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
app.post('/api/pick/file', async (req, reply) => {
  try {
    const stub = process.env.SOLITERRA_PICK_STUB_FILE;
    let p = stub || '';
    if (!stub) {
      const r = await pickImage({ prompt: '选择封面图片', defaultPath: req.body?.default || '' });
      if (r.canceled) return { ok: false, canceled: true };
      p = r.path;
    }
    const out = { ok: true, path: p, name: path.basename(p) };
    try {
      const st = fs.statSync(p);
      out.size = st.size;
      // 预览：≤8MB 直接内联 dataUrl（向导缩略图；大图只回路径）——第 105 轮异步读（原同步阻塞）
      if (st.size <= 8 * 1024 * 1024) {
        const mime = PICK_MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
        const buf = await fs.promises.readFile(p);
        out.dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      }
    } catch { /* 预览失败不影响返回路径 */ }
    return out;
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 采纳本地文件夹（第 88 轮）：检查（向导第一步）+ 落地
app.post('/api/worlds/inspect', (req, reply) => {
  try { return vault.inspectFolder(req.body?.dir); }
  catch (e) { reply.code(400).send({ error: e.message }); }
});
app.post('/api/worlds/adopt', async (req, reply) => {
  try {
    const { dir, intro, coverPath, calendar, timeline } = req.body || {};
    return await vault.adoptFolder({ dir, intro, coverPath, calendar, timeline });
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 世界/书籍详情保存（第 115 轮）：字段原子落盘（改名/介绍段/历法/时间线追加/封面设或移除）
app.post('/api/w/:id/worldinfo', (req, reply) => {
  try { return vault.applyWorldInfo(req.params.id, req.body || {}); }
  catch (e) { reply.code(400).send({ error: e.message }); }
});
app.post('/api/w/:id/bookinfo', (req, reply) => {
  try { return vault.applyBookInfo(req.params.id, req.body || {}); }
  catch (e) { reply.code(400).send({ error: e.message }); }
});

// 封面设置（第 92 轮）：世界 = README.md 的 &m；书/条目 = 各自 md 的 &m——图形化详情面板与元数据抽屉共用。
// writeMeta=false → 只收图进 assets/covers/（编辑态由编辑器文本写 &m，防 mtime 互踩）。
app.post('/api/w/:id/cover', async (req, reply) => {
  try {
    const { path: rel, image, writeMeta } = req.body || {};
    return vault.setCover(req.params.id, String(rel || ''), String(image || ''), { writeMeta: writeMeta !== false });
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

app.post('/api/worlds', async (req, reply) => {
  try {
    const { name, subtitle, timeline, cover, calendar } = req.body || {};
    return await vault.create({ name: (name || '').trim(), subtitle, timeline, cover, calendar });
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

app.get('/api/w/:id/tree', (req) => vault.index(req.params.id).tree());
app.get('/api/w/:id/stats', (req) => ({ ...vault.index(req.params.id).stats(), dir: vault.realDir(req.params.id) }));
app.get('/api/w/:id/timeline', (req) => vault.index(req.params.id).timeline());
app.get('/api/w/:id/search', (req) => vault.index(req.params.id).search(req.query.q || ''));

app.get('/api/w/:id/entry', (req, reply) => {
  const rel = req.query.path;
  try {
    const idx = vault.index(req.params.id);
    const e = idx.entry(rel);
    if (!e) return reply.code(404).send({ error: 'entry not found' });
    const raw = vault.readEntryRaw(req.params.id, rel);
    // 方向 B（§8.4）：![[条目#锚]] 真嵌入（深度 1）
    const resolver = (target, anchor) => {
      const hit = idx.resolve(target);
      if (!hit) return null;
      const row = idx.entry(hit.path);
      if (!row) return null;
      let text = row.body || '';
      if (anchor) {
        const sec = sectionOf(text, anchor);
        if (!sec) return null;
        text = sec;
      }
      return renderFragment(text);
    };
    const { html, topMetaHTML, rangeHTML } = renderEntry(e.body, e.meta, e.title, req.query.lang || "zh-CN", resolver);
    return { ...e, raw, html, topMetaHTML, rangeHTML, mtime: vault.entryMtime(req.params.id, rel) };
  } catch (err) { reply.code(400).send({ error: err.message }); }
});

app.get('/api/w/:id/raw', (req, reply) => {
  try {
    return { text: vault.readEntryRaw(req.params.id, req.query.path), mtime: vault.entryMtime(req.params.id, req.query.path) };
  }
  catch (e) { reply.code(400).send({ error: e.message }); }
});

// 第 92 轮：mtime 乐观锁——baseMtime 与磁盘不一致且未 force → 409（前端弹覆盖确认，绝不静默覆盖外部修改）
app.post('/api/w/:id/save', (req, reply) => {
  try {
    const { path: rel, text, baseMtime, force } = req.body || {};
    return vault.saveEntry(req.params.id, rel, text, { baseMtime: baseMtime ?? null, force: !!force });
  } catch (e) {
    if (e.status === 409) return reply.code(409).send({ error: e.message, serverMtime: e.serverMtime });
    reply.code(400).send({ error: e.message });
  }
});

// 文件监听推送（第 92 轮）：chokidar 事件 → SSE——外部改动（Obsidian/编辑器）前端即时可感知
app.get('/api/w/:id/events', (req, reply) => {
  const id = req.params.id;
  try { vault.index(id); } catch { /* 世界不存在 → 仍可挂流，事件不会来 */ }
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  reply.raw.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  const off = vault.onFsChange(id, (data) => {
    try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
  });
  const hb = setInterval(() => { try { reply.raw.write(': hb\n\n'); } catch { /* 已断 */ } }, 25000);
  req.raw.on('close', () => { off(); clearInterval(hb); try { reply.raw.end(); } catch { /* 已断 */ } });
});

// 树移动（拖动）：md 与同名目录成对联动；不自动提交（累计未提交）
// 结构操作（§5.4 操作流②③④ + 重命名/删除）：成对联动；不自动提交
app.post('/api/w/:id/fs/create', (req, reply) => {
  try {
    const { dir, name, pair } = req.body || {};
    return { ok: true, ...vault.createEntry(req.params.id, dir || '', name, !!pair) };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});
app.post('/api/w/:id/fs/rename', (req, reply) => {
  try {
    const { path: rel, newName } = req.body || {};
    return { ok: true, ...vault.renameEntry(req.params.id, rel, newName) };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});
app.post('/api/w/:id/fs/delete', (req, reply) => {
  try {
    const { path: rel } = req.body || {};
    return { ok: true, ...vault.deleteEntry(req.params.id, rel) };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 目录内自定义排序（第 91 轮）：按给定顺序整层重写 `&r`（1 起）；纯目录节点自动跳过
app.post('/api/w/:id/fs/order', (req, reply) => {
  try {
    const { dir, order } = req.body || {};
    return { ok: true, ...vault.setOrder(req.params.id, dir || '', order) };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 归档 / 取消归档（第 90 轮）：书 = `.md → .md.arc`；条目 = 移入 books/archives/ + `&x` 原位置
app.post('/api/w/:id/fs/archive', (req, reply) => {
  try { return { ok: true, ...vault.archiveNode(req.params.id, String(req.body?.rel || '')) }; }
  catch (e) { reply.code(400).send({ error: e.message }); }
});
app.post('/api/w/:id/fs/unarchive', (req, reply) => {
  try { return { ok: true, ...vault.unarchiveNode(req.params.id, String(req.body?.rel || '')) }; }
  catch (e) { reply.code(400).send({ error: e.message }); }
});
app.get('/api/w/:id/archives', (req, reply) => {
  try { return vault.listArchives(req.params.id); }
  catch (e) { reply.code(500).send({ error: e.message }); }
});

app.post('/api/w/:id/fs/move', (req, reply) => {
  try {
    const { path: relFrom, toDir } = req.body || {};
    return { ok: true, ...vault.moveEntry(req.params.id, relFrom, toDir) };
  } catch (e) { reply.code(400).send({ error: e.message }); }
});

// 只读站点发布（§15.7）：产物落盘 assets/exports/site-<ts>/；不自动提交（由作者随 git 带走/推送）
app.post('/api/w/:id/publish', (req, reply) => {
  try {
    const { visibility, lang } = req.body || {};
    return buildSite(vault.worldDir(req.params.id), { visibility, lang: lang || 'zh-CN' });
  } catch (e) { reply.code(500).send({ error: e.message }); }
});

// §B.3.4 实时预览：只读渲染（不写盘、不索引）——输入原文 → 与阅读态同管线 HTML
app.post('/api/w/:id/render', (req, reply) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string') return reply.code(400).send({ error: 'text required' });
    const e = parseEntry('preview.md', text);
    const { html, topMetaHTML, rangeHTML } = renderEntry(e.body, e.meta, e.title, 'zh-CN');
    return { html, topMetaHTML, rangeHTML, title: e.title };
  } catch (err) { reply.code(400).send({ error: err.message }); }
});

app.get('/api/w/:id/settings', (req) => vault.getSettings(req.params.id));
app.post('/api/w/:id/settings', (req) => vault.saveSettings(req.params.id, req.body || {}));

// ---------- 图片资产（§B.5 图片管线）：上传（原始二进制）+ 列表 ----------
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const ASSET_MAX = 10 * 1024 * 1024;
app.addContentTypeParser(
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'application/octet-stream'],
  { parseAs: 'buffer' },
  (req, body, done) => done(null, body),
);
app.post('/api/w/:id/asset', (req, reply) => {
  const name = String(req.query.name || 'image.png');
  const ext = path.extname(name).toLowerCase();
  if (!ASSET_EXT.has(ext)) return reply.code(400).send({ error: `不支持的图片类型：${ext || '(无扩展名)'}` });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return reply.code(400).send({ error: '空文件' });
  if (buf.length > ASSET_MAX) return reply.code(413).send({ error: '超过 10MB 限制' });
  try { return { path: vault.saveAsset(req.params.id, name, buf) }; }
  catch (e) { return reply.code(500).send({ error: e.message }); }
});
app.get('/api/w/:id/assets', (req, reply) => {
  try { return { items: vault.listAssets(req.params.id) }; }
  catch (e) { return reply.code(500).send({ error: e.message }); }
});

app.get('/api/w/:id/readlater', (req) => vault.getReadlater(req.params.id));
app.post('/api/w/:id/readlater', (req) => {
  const { action, item, path: rel } = req.body || {};
  if (action === 'add' && item?.path) return vault.addReadlater(req.params.id, item);
  if (action === 'remove' && rel) return vault.removeReadlater(req.params.id, rel);
  return vault.getReadlater(req.params.id);
});

app.get('/api/w/:id/dashboard', async (req) => {
  const d = vault.index(req.params.id).dashboard(vault.worldDir(req.params.id));
  d.commitsWeek = await vault.gitCommitsSince(req.params.id, 7);
  return d;
});
app.get('/api/w/:id/git', async (req) => vault.gitInfo(req.params.id));
app.get('/api/w/:id/git/status', async (req) => vault.gitStatus(req.params.id));
app.get('/api/w/:id/git/log', async (req) => ({ commits: await vault.gitLog(req.params.id) }));
app.get('/api/w/:id/git/show', async (req) => ({ files: await vault.gitShow(req.params.id, req.query.rev) }));
app.get('/api/w/:id/git/file', async (req) => ({ text: await vault.gitFile(req.params.id, req.query.rev, req.query.path) }));
app.post('/api/w/:id/git/rollback', async (req, reply) => {
  const r = await vault.gitRollback(req.params.id, req.body?.rev);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  try { vault.index(req.params.id).rebuild?.(); } catch { /* 索引由监听器兜底 */ }
  return r;
});

// 工具箱（功能设计 §12）：扫描 → diff 预览 → 批量应用（备份+提交）
app.get('/api/w/:id/tools/scan', (req, reply) => {
  const tool = req.query.tool;
  if (tool === 'lint') {
    try { return { items: lint(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'dup') {
    try { return { items: scanDuplicates(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'drift') {
    try { return { items: scanDrift(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'images') {
    try { return { items: scanImages(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'regex') {
    try { return { items: scanRegex(vault.worldDir(req.params.id), req.query.q || '', req.query.r || '') }; }
    catch (e) { return reply.code(400).send({ error: '正则无效: ' + e.message }); }
  }
  if (tool === 'onboard') {
    try { return { items: scanOnboard(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'symbols') {
    try { return { items: scanSymbols(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'cover') {
    try { return { items: scanCover(vault.worldDir(req.params.id)) }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (tool === 'structure') {
    try { return { items: scanStructure(vault.worldDir(req.params.id)).items }; }
    catch (e) { return reply.code(500).send({ error: e.message }); }
  }
  if (!['date', 'brackets'].includes(tool)) return reply.code(400).send({ error: 'unknown tool' });
  try { return { items: scan(vault.worldDir(req.params.id), tool) }; }
  catch (e) { reply.code(500).send({ error: e.message }); }
});

app.post('/api/w/:id/tools/apply', (req, reply) => {
  const { tool, items } = req.body || {};
  const APPLY_TOOLS = ['date', 'brackets', 'symbols', 'cover', 'dup', 'drift', 'images', 'regex', 'onboard', 'structure'];
  if (!APPLY_TOOLS.includes(tool) || !Array.isArray(items)) {
    return reply.code(400).send({ error: 'bad request' });
  }
  try {
    const dir = vault.worldDir(req.params.id);
    // 结构规范化（第 89 轮）：文本改写 + 文件/目录搬迁（applyStructure 内部按旧路径先改后搬）
    const r = tool === 'structure' ? applyStructure(dir, items) : applyTool(dir, tool, items);
    // 重索引：结构工具可能搬迁整棵目录 → 全量重建（其它工具按受影响文件增量）
    const idx = vault.index(req.params.id);
    if (tool === 'structure') idx.rebuild?.();
    else {
      const paths = new Set(items.map((x) => x.path));
      for (const rel of paths) idx.indexFile(rel);
    }
    return r;
  } catch (e) { reply.code(500).send({ error: e.message }); }
});
app.post('/api/w/:id/commit', async (req) => vault.gitCommit(req.params.id, req.body?.message || 'edit'));

app.get('/api/w/:id/resolve', (req, reply) => {
  const hit = vault.index(req.params.id).resolve(req.query.target);
  return hit ? { path: hit.path, title: hit.title } : { path: null };
});

// 关系图：全库（功能设计 §9.3「展开全图」）
app.get('/api/w/:id/graph/all', (req) => vault.index(req.params.id).graphAll());

// 关系图：一跳邻里（中心 + 出链 [+ 反链]）——功能设计 §9.0
app.get('/api/w/:id/graph', (req, reply) => {
  const idx = vault.index(req.params.id);
  const data = idx.graph(req.query.path, req.query.backlinks === '1');
  if (!data) return reply.code(404).send({ error: 'entry not found' });
  return data;
});

// ---------- 启动 ----------
try {
  await app.listen({ host: '127.0.0.1', port: PORT });
  // PORT=0（测试）→ 打印系统分配的实际端口（第 106 轮：冒烟测试解析 stdout 直接拿）
  const actualPort = app.server.address()?.port || PORT;
  console.log(`\n  SOLITERRA\n  ─────────\n  http://127.0.0.1:${actualPort}\n  worlds: ${worldsDir}\n`);
  if (!fs.existsSync(worldsDir)) {
    console.log(`  ⚠ 世界库目录不存在——复制 soliterra.config.example.json 为 soliterra.config.json 并设置 worldsDir（或 node server.js <worldsDir> / 环境变量 SOLITERRA_WORLDS）\n`);
  }
} catch (e) {
  console.error('启动失败：', e.message);
  process.exit(1);
}

process.on('SIGINT', () => { vault.closeAll(); process.exit(0); });
