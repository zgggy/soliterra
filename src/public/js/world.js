// 世界内工作台——编排层（功能设计 §2/§3/§4/§7/§8/§10/§11）。
// 第 92 轮拆分：时间轴 → world-timeline.js · 目录树 → world-tree.js · 关系图 → world-rel.js ·
//   元数据抽屉 → world-meta.js · 稍后阅读 → world-readlater.js · 共享原语 → ui.js · 缓存与树辅助 → world-core.js。
// 本文件保留：renderWorld 装配 / 面板原语 / 世界与书籍面板 / 设置 / 导出 / git 历史纸面 / ⌘K / 编辑器 / 阅读。

import { api, t, state, navigate, bindCoverFallbacks, abbrevPath, applyGlobalFont, currentFont } from './app.js';
import { showLinkCard, leaveAnchor } from './linkcard.js';
import { attachTilt } from './home.js';
import { download, subtreePaths, mdToTxt, buildEpub, buildDocx } from './exporter.js';
import { esc, enc, parseOrd, debounce, showToast, lt, ICON, askText, confirmModal, openPaperDialog2, checkHTML, bindChecks, attachScrollIndicators } from './ui.js';
import { worldDataCache, hooks, refreshGitStatus, refreshTimeline, currentBookOf, rootNodeOf, topBookNodes, topOfPath, firstEntryOf, flattenTree, nextEntry, prevEntry } from './world-core.js';
import { initTimeline } from './world-timeline.js';
import { refreshTree, renderToc, updateTocCurrent, showTreeMenu, reorderNode } from './world-tree.js';
import { renderRel } from './world-rel.js';
import { renderReadlater, addReadlater } from './world-readlater.js';
import { renderMetaDrawer, openMetaEditor, editMetaValue, insertMetaIntoText } from './world-meta.js';
import './world-detail.js';   // 第 92 轮：详情面板（注册 hooks；首页与树菜单经 hooks 调用）

let activeWorld = null;           // { id, update(path) }：同世界导航走原地更新（不整页重载）
let openSeq = 0;                 // openEntry 渲染序号（第 85 轮：过期渲染丢弃，防双开竞态错乱）
let worldKeyHandler = null;     // 世界快捷键 handler 单例（重绑即解绑，防多实例叠加）
let fsSource = null;            // SSE 订阅单例（第 92 轮：外部改动 → 前端刷新）
let fsDebounce = null;          // 事件防抖句柄
// 拆分桥接：core/各模块经 hooks 回调 world.js 的面板与阅读入口（避免 import 环）
hooks.renderBooksPanel = renderBooksPanel;
hooks.openEntry = openEntry;
export async function renderWorld(root, worldId, entryPath) {
  root.innerHTML = `
    <div class="world-view">
      <div class="chrono-bar" id="chrono">
        <div class="chrono-canvas" id="chrono-canvas"></div>
        <div class="chrono-ticks" id="chrono-ticks"></div>
      </div>
      <div class="chrono-resize" id="chrono-resize" title="${state.lang === 'zh-CN' ? '拖动调整高度' : 'Drag to resize'}"></div>
      <div class="world-shell" id="shell">
        <aside class="push-panel" id="panel-left"></aside>
        <main class="reader-column" id="reader"><div class="loading">${t('world.loading')}</div></main>
        <aside class="push-panel" id="panel-right"></aside>
      </div>

      <!-- 左下三钮：+ 世界面板 · 全部书籍 · 目录 -->
      <div class="fab-cluster fab-left" id="fab-left">
        <button class="fab" id="fab-world" title="${lt('world')}">${ICON.plus}</button>
        <button class="fab" id="fab-books" title="${lt('shelfAll')}">${ICON.grid}</button>
        <button class="fab" id="fab-toc" title="${t('tree.title')}">${ICON.menu}</button>
      </div>
      <!-- 右下三钮：开始编辑 · 展示关系 · 工具（与左侧对称） -->
      <div class="fab-cluster fab-right" id="fab-right">
        <button class="fab" id="fab-edit" title="${t('reader.edit')}">${ICON.pencil}</button>
        <button class="fab" id="fab-rel" title="${lt('showRel')}">${ICON.rel}</button>
        <button class="fab" id="fab-tools" title="${lt('tools')}">${ICON.tools}</button>
      </div>

      <!-- 底部中央：稍后阅读卡片集（rest = 扇形聚拢；hover = 横排展开） -->
      <div class="readlater-fan" id="readlater-fan"><div class="rlf-set" id="rlf-set"></div></div>
    </div>`;

  const el = (id) => root.querySelector(`#${id}`);

  // ---------- 数据加载 ----------
  let tree = null, timeline = [], settings = {}, readlater = [];
  try {
    const cached = worldDataCache.get(worldId);
    const fresh = cached && Date.now() - cached.ts < 5000
      ? cached
      : await Promise.all([
          api(`/api/w/${enc(worldId)}/tree`),
          api(`/api/w/${enc(worldId)}/timeline`),
        ]).then(([t, tl]) => ({ tree: t, timeline: tl, ts: Date.now() }));
    worldDataCache.set(worldId, fresh);
    tree = fresh.tree; timeline = fresh.timeline;
    [settings, readlater] = await Promise.all([
      api(`/api/w/${enc(worldId)}/settings`),
      api(`/api/w/${enc(worldId)}/readlater`),
    ]);
  } catch (e) {
    el('reader').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    return;
  }

  const ctx = {
    worldId, tree, timeline, currentPath: entryPath, editing: false, settings, readlater, panel: null,
    pins: new Set(JSON.parse(sessionStorage.getItem(`soliterra.pins.${worldId}`) || '[]')),   // 强调过=保留在时间轴
  };
  ctx.onCreateMissing = (target) => createMissingEntry(ctx, target);   // 缺条目卡「创建文件」（第 91 轮）
  watchFsEvents(ctx);   // 第 92 轮：SSE——外部改动（Obsidian/编辑器）→ 树/时间轴/当前条目自动刷新
  // 面板宽度（sessionStorage 记忆）：目录 / 全部书籍 / 关系；世界面板固定宽（不可调）
  const shell = el('shell');
  const px = (n) => Math.round(n) + 'px';
  shell.style.setProperty('--toc-w', sessionStorage.getItem('soliterra.tocW') || px(innerWidth / 3));
  shell.style.setProperty('--books-w', sessionStorage.getItem('soliterra.booksW') || px(innerWidth / 3));
  shell.style.setProperty('--rel-w', sessionStorage.getItem('soliterra.relW') || px(innerWidth / 2));
  shell.style.setProperty('--world-w', px(Math.min(420, innerWidth * 0.4)));
  applySettings(ctx);
  renderReadlater(ctx);
  refreshGitStatus(ctx);

  // 时间轴高度（可拖动；最矮 56 限定）：56–320px，sessionStorage 记忆
  const chronoH = parseInt(sessionStorage.getItem('soliterra.chronoH') || '112', 10);
  root.querySelector('.world-view').style.setProperty('--chrono-h', Math.min(Math.round(window.innerHeight * 0.75), Math.max(70, chronoH)) + 'px');   // §A：上限 3/4 屏高（>2/3 即高模式）
  const chrono = initTimeline(ctx, el('chrono'), el('chrono-canvas'), el('chrono-ticks'));
  ctx.scopeTop = ctx.currentPath ? topOfPath(ctx.currentPath) : null;   // 时间轴范围当前所属（第 89 轮：剥 books/ 前缀）
  chrono.layout();
  bindChronoResize(root, ctx, chrono);

  // ---------- fab 接线 ----------
  el('fab-edit').addEventListener('click', () => { if (ctx.currentPath) (ctx.editing ? exitEdit(ctx) : enterEdit(ctx)); });
  el('fab-world').addEventListener('click', () => setPanel(ctx, ctx.panel === 'world' ? '' : 'world'));
  el('fab-books').addEventListener('click', () => setPanel(ctx, ctx.panel === 'books' ? '' : 'books'));
  el('fab-toc').addEventListener('click', () => setPanel(ctx, ctx.panel === 'toc' ? '' : 'toc'));
  el('fab-rel').addEventListener('click', () => { if (ctx.panel === 'rel') setPanel(ctx, ''); else { ctx.graphMode = 'neighbor'; setPanel(ctx, 'rel'); } });
  el('fab-tools').addEventListener('click', () => setPanel(ctx, ctx.panel === 'tools' ? '' : 'tools'));
  ctx.onAddLater = (path) => addReadlater(ctx, path);

  if (worldKeyHandler) window.removeEventListener('keydown', worldKeyHandler);
  worldKeyHandler = handleKeys;
  window.addEventListener('keydown', worldKeyHandler);
  function handleKeys(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setPanel(ctx, ctx.panel === 'toc' ? '' : 'toc'); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(ctx); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); setPanel(ctx, ctx.panel === 'rel' ? '' : 'rel'); }
    if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); if (ctx.panel === 'rel') setPanel(ctx, ''); }
    if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); if (ctx.currentPath) { ctx.graphMode = 'full'; setPanel(ctx, 'rel'); } }
    if (e.key === 'Escape') setPanel(ctx, '');
  }

  // 时间轴智能收拢：主区下滚 > 80px + 进度记忆（防抖 400ms 存 localStorage，跨会话）
  const readerCol = el('reader');
  let scrollSaveTimer = null;
  readerCol.addEventListener('scroll', () => {
    // 智能收拢已删除（2026-10-06）：正文滚动不再改变时间轴高度
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      if (ctx.currentPath) {
        try { localStorage.setItem(`soliterra.scroll.${worldId}.${ctx.currentPath}`, String(Math.round(readerCol.scrollTop))); } catch {}
      }
    }, 400);
  });

  // ---------- 面板先于阅读恢复（避免目录区先空白后跳出 → 闪烁） ----------
  // 第 92 轮用户要求：进入世界默认打开「全部书籍」面板——进入流 = 世界 → 书籍 → （点书）目录。
  // 世界内换条目/换书不走本函数（activeWorld.update 原地更新），因此阅读中翻页不会重置面板。
  if (entryPath) { setPanel(ctx, 'books'); ctx.panelPainted = true; }

  // ---------- 阅读 ----------
  if (entryPath) {
    await openEntry(ctx, entryPath, chrono);
  } else {
    // 默认：打开根条目（README.md 优先；历史世界 = 同名书首页），并展开目录
    const rootBook = rootNodeOf(ctx);
    const first = rootBook ? firstEntryOf(rootBook) : null;
    if (first) {
      sessionStorage.setItem('soliterra.panel', 'books');   // 进入流：世界 → 书籍面板 → 目录
      navigate(`#/w/${enc(worldId)}/${enc(first)}`);
      return;
    }
    el('reader').innerHTML = `<div class="empty-state">${t('reader.empty')}</div>`;
  }
  attachScrollIndicators(root);

  ctx.chrono = chrono;
  activeWorld = {
    id: worldId,
    /** 世界内导航（同世界、仅换文档）：只重载正文 + 定向更新面板，不整页重渲染。 */
    update: async (path) => {
      if (!document.getElementById('shell') || !path) return false;
      await openEntry(ctx, path, chrono);
      return true;
    },
  };
}

/** SSE 订阅（第 92 轮）：服务端 chokidar 事件 → 800ms 防抖 → 树/时间轴/关系图/当前条目刷新。
 *  外部改动第一次在这套系统里有 UI 可感知路径；平台自身写盘也会触发，但刷新是幂等的。 */
function watchFsEvents(ctx) {
  if (fsSource) { try { fsSource.close(); } catch {} }
  const zh = state.lang === 'zh-CN';
  const pending = new Set();
  fsSource = new EventSource(`/api/w/${enc(ctx.worldId)}/events`);
  fsSource.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.path) pending.add(d.path);
    clearTimeout(fsDebounce);
    fsDebounce = setTimeout(async () => {
      const paths = new Set(pending); pending.clear();
      if (!paths.size) return;
      try {
        await refreshTree(ctx);
        await refreshTimeline(ctx);
        if (ctx.panel === 'rel') renderRel(ctx, ctx.graphMode);
      } catch { /* 世界已删等情况：忽略 */ }
      // 当前条目被外部改动且非编辑态 → 原地重载（滚动位置先落 localStorage，openEntry 会恢复）
      if (paths.has(ctx.currentPath) && !ctx.editing && ctx.currentPath) {
        try { localStorage.setItem(`soliterra.scroll.${ctx.worldId}.${ctx.currentPath}`, String(document.getElementById('reader')?.scrollTop || 0)); } catch {}
        showToast(zh ? '文件已被外部修改——已重新加载' : 'File changed externally — reloaded', 'info');
        openEntry(ctx, ctx.currentPath, ctx.chrono);
      }
    }, 800);
  };
  fsSource.onerror = () => { /* 断线由 EventSource 自动重连 */ };
}

/** 离开世界（回首页）→ 注销原地更新实例 + 关闭 SSE 订阅（防连接泄漏与陈旧回调）。 */
export function leaveWorld() {
  activeWorld = null;
  if (fsSource) { try { fsSource.close(); } catch {} fsSource = null; }
  clearTimeout(fsDebounce);
}

/** 当前世界实例（供路由判定是否原地更新）。 */
export function currentWorld() { return activeWorld; }

// ============ 面板管理（push 原语：左=世界/全部书籍/目录；右=关系/工具；互斥） ============
function setPanel(ctx, name) {
  ctx.panel = name;
  sessionStorage.setItem('soliterra.panel', name || '');
  const shell = document.getElementById('shell');
  const left = document.getElementById('panel-left');
  const right = document.getElementById('panel-right');
  if (!shell) return;
  shell.classList.toggle('push-left', name === 'world' || name === 'books' || name === 'toc');
  shell.classList.toggle('p-world', name === 'world');
  shell.classList.toggle('p-books', name === 'books');
  shell.classList.toggle('p-toc', name === 'toc');
  shell.classList.toggle('push-right', name === 'rel' || name === 'tools');
  shell.classList.toggle('p-rel', name === 'rel');
  shell.classList.toggle('p-tools', name === 'tools');
  if (name !== 'rel') shell.classList.remove('rel-full');
  for (const [id, nm] of [['fab-world', 'world'], ['fab-books', 'books'], ['fab-toc', 'toc'], ['fab-rel', 'rel'], ['fab-tools', 'tools']]) {
    document.getElementById(id)?.classList.toggle('active', name === nm);
  }
  left.classList.remove('live'); right.classList.remove('live');
  left.innerHTML = ''; right.innerHTML = '';   // 不设 hidden：面板常驻栅格（隐藏会移出布局 → 轨道错位）
  if (!name) return;
  if (name === 'world' || name === 'books' || name === 'toc') { left.classList.add('live'); renderLeftPanel(ctx, name); }
  else { right.classList.add('live'); renderRightPanel(ctx, name); }
}

/** 新建书籍向导（第 97 轮：与新建世界同级的表单——书名 + 简介 + 封面，替代原单输入框）。
 *  简介写入 `books/名.md`（&n + # 标题 + 简介）；封面两个入口：本机系统对话框（复制进 assets/covers/）
 *  与世界内 assets 选择器（原样引用）——服务端 setCover 对两种入参同源处理。 */
function addBook(ctx) {
  const zh = state.lang === 'zh-CN';
  return new Promise((resolve) => {
    let coverPath = null;      // 本机绝对路径（pick/file 返回）或 assets 相对路径（选择器返回）
    let coverDataUrl = null;   // 本机预览（≤8MB 内联）
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog ask-dialog">
        <div class="modal-header"><span class="eyebrow">${zh ? '新建书籍' : 'New book'}</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-scroll">
          <label class="field"><span class="eyebrow">${zh ? '书名' : 'Book name'}</span>
            <input class="text-input ab-name" autofocus></label>
          <label class="field"><span class="eyebrow">${zh ? '简介（写入 books/书名.md）' : 'Intro (written to books/name.md)'}</span>
            <textarea class="text-input ab-intro" rows="3"></textarea></label>
          <label class="field"><span class="eyebrow">${zh ? '封面（写入 &m）' : 'Cover (writes &m)'}</span>
            <span class="wz-cover-row">
              <button class="button-ghost ab-cover-local" type="button">${zh ? '从本机选择…' : 'From disk…'}</button>
              <button class="button-ghost ab-cover-assets" type="button">${zh ? '从 assets 选择…' : 'From assets…'}</button>
              <span class="wz-cover-preview ab-cover-prev" hidden><img class="ab-cover-thumb" alt=""><span class="wz-cover-name ab-cover-name"></span><button class="button-ghost ab-cover-clear" type="button">${zh ? '移除' : 'Remove'}</button></span>
            </span></label>
          <div class="modal-actions">
            <button class="button-ghost" data-close>${zh ? '取消' : 'Cancel'}</button>
            <button class="button-primary ab-ok" disabled>${zh ? '创建并进入' : 'Create'}</button>
          </div>
          <p class="modal-error" hidden></p>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => { modal.remove(); resolve(null); };
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    const err = modal.querySelector('.modal-error');
    const showErr = (m) => { err.hidden = false; err.textContent = m; };
    const nameInput = modal.querySelector('.ab-name');
    const okBtn = modal.querySelector('.ab-ok');
    nameInput.addEventListener('input', () => { err.hidden = true; okBtn.disabled = !nameInput.value.trim(); });

    const paintCover = () => {
      const prev = modal.querySelector('.ab-cover-prev');
      const thumb = modal.querySelector('.ab-cover-thumb');
      if (!coverPath) { prev.hidden = true; return; }
      prev.hidden = false;
      if (coverDataUrl) thumb.src = coverDataUrl;
      else if (coverPath.startsWith('assets/')) thumb.src = `/w/${enc(ctx.worldId)}/${enc(coverPath)}?t=${Date.now()}`;
      else thumb.src = '';
      modal.querySelector('.ab-cover-name').textContent = coverPath.split('/').pop();
    };
    // 本机：系统对话框（≤8MB 返回 dataUrl 预览）
    modal.querySelector('.ab-cover-local').addEventListener('click', async (e2) => {
      const btn = e2.currentTarget; btn.disabled = true;
      try {
        const r = await api('/api/pick/file', { method: 'POST', body: {} });
        if (r.ok) { coverPath = r.path; coverDataUrl = r.dataUrl || null; paintCover(); }
      } catch (e3) { showErr(String(e3.message)); }
      btn.disabled = false;
    });
    // assets：世界内图片选择器（路径已在库内 → 服务端原样引用不复制）
    modal.querySelector('.ab-cover-assets').addEventListener('click', async () => {
      const picked = await openAssetPicker(ctx);
      if (picked) { coverPath = picked.path; coverDataUrl = null; paintCover(); }
    });
    modal.querySelector('.ab-cover-clear').addEventListener('click', () => { coverPath = null; coverDataUrl = null; paintCover(); });

    okBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      okBtn.disabled = true;
      try {
        const r = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: 'books', name, pair: true } });
        const intro = modal.querySelector('.ab-intro').value.trim();
        if (intro) {
          await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: r.path, text: `&n ${name}\n\n# ${name}\n\n${intro}\n` } });
        }
        if (coverPath) await api(`/api/w/${enc(ctx.worldId)}/cover`, { method: 'POST', body: { path: r.path, image: coverPath } });
        close();
        await refreshTree(ctx);
        refreshGitStatus(ctx);
        showToast(zh ? `已建书：books/${name}` : `Book created: books/${name}`, 'success');
        if (r.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r.path)}`);
        resolve(r.path);
      } catch (e2) { showErr(String(e2.message)); okBtn.disabled = false; }
    });
    nameInput.focus();
  });
}

/** 新建条目（第 81 轮：目录面板 ＋ 的语义 = **在当前书内加条目**；「新建书」归书籍面板 ＋）。 */
async function addEntry(ctx) {
  const name = await askText(state.lang === 'zh-CN' ? '新条目名' : 'Entry name');
  if (!name || !name.trim()) return;
  try {
    const book = currentBookOf(ctx);
    const dir = book?.dir || '';
    if (!dir) {
      // 第 89 轮规范：世界根只放 README.md 与 books/ ——散条目一律拒建，指路到书籍面板
      showToast(state.lang === 'zh-CN'
        ? '世界根只放 README 与 books/ —— 请先在「全部书籍」面板 ＋ 新建书，或打开某本书再加条目'
        : 'World root only holds README and books/ — create a book first', 'warning');
      return;
    }
    const r = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir, name: name.trim(), pair: false } });
    await refreshTree(ctx);
    refreshGitStatus(ctx);
    showToast(state.lang === 'zh-CN' ? `已新建：${name.trim()}` : `Created: ${name.trim()}`, 'success');
    if (r.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r.path)}`);
  } catch (e) { showToast(String(e.message), 'error'); }
}

function renderLeftPanel(ctx, name) {
  const host = document.getElementById('panel-left');
  const resize = (cssVar, storeKey) =>
    `<div class="panel-resize" id="panel-resize" title="${state.lang === 'zh-CN' ? '拖动调整宽度' : 'Drag to resize'}"></div>`;
  if (name === 'toc') {
    host.innerHTML = `
      ${resize()}
      <div class="panel-head"><span class="eyebrow">${t('tree.title')}</span>
        <button class="panel-head-btn" id="toc-add-entry" title="${state.lang === 'zh-CN' ? '新条目（加在当前书内）' : 'New entry'}">＋</button>
      </div>
      <div class="panel-scroll"><div class="toc-body" id="toc-body"></div></div>`;
    renderToc(ctx);
    bindPanelResize(ctx, 'left', '--toc-w', 'soliterra.tocW');
    document.getElementById('toc-add-entry')?.addEventListener('click', () => addEntry(ctx));
  } else if (name === 'world') {
    host.innerHTML = `<div class="panel-scroll" id="wp-embed"></div>`;
    renderWorldPanel(ctx);
  } else if (name === 'books') {
    host.innerHTML = `
      ${resize()}
      <div class="panel-head"><span class="eyebrow">${lt('shelfAll')}</span><span class="panel-count" id="books-count"></span>
        <button class="panel-head-btn" id="books-add-book" title="${state.lang === 'zh-CN' ? '加一本书' : 'New book'}">＋</button>
      </div>
      <div class="books-filter" id="books-filter"></div>
      <div class="panel-scroll"><div class="books-grid" id="books-grid"></div></div>`;
    renderBooksPanel(ctx);
    bindPanelResize(ctx, 'left', '--books-w', 'soliterra.booksW');
    document.getElementById('books-add-book')?.addEventListener('click', () => addBook(ctx));
  }
}

function renderRightPanel(ctx, name) {
  const host = document.getElementById('panel-right');
  if (name === 'rel') {
    if (!ctx.currentPath) { setPanel(ctx, ''); return; }
    host.innerHTML = `
      <div class="panel-resize right-edge" id="panel-resize" title="${state.lang === 'zh-CN' ? '拖动调整宽度' : 'Drag to resize'}"></div>
      <div class="rel-inner" id="rel"></div>`;
    ctx.graphMode = ctx.graphMode || 'neighbor';
    renderRel(ctx, ctx.graphMode);
    bindPanelResize(ctx, 'right', '--rel-w', 'soliterra.relW');
  } else if (name === 'tools') {
    host.innerHTML = `
      <div class="panel-head"><span class="eyebrow">${lt('toolsTitle')}</span></div>
      <div class="rel-inner" id="tools-host"></div>`;
    renderTools(ctx);
  }
}

/** 时间轴高度拖动：60×10 矩形把手骑在时间轴下边界正中；指针距边界 ≤40px 才显示；最矮 56 限定。 */
function bindChronoResize(root, ctx, chrono) {
  const bar = document.getElementById('chrono');
  const handle = document.getElementById('chrono-resize');
  if (!bar || !handle) return;
  const setNear = (show) => handle.classList.toggle('near-edge', show);
  // 高度带 200ms 过渡：过渡结束后按最终高度重排（紧凑/分道取终值）
  bar.addEventListener('transitionend', (e) => { if (e.propertyName === 'height') chrono.layout(); });
  document.addEventListener('mousemove', (e) => {
    const r = bar.getBoundingClientRect();
    setNear(Math.abs(e.clientY - r.bottom) <= 40);
  });
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = bar.getBoundingClientRect().height;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    handle.classList.add('active');
    bar.classList.add('no-h-anim');        // 拖动中禁用高度过渡：面板边缘 1:1 跟手
    const move = (ev) => {
      const h = Math.min(Math.round(window.innerHeight * 0.75), Math.max(70, startH + (ev.clientY - startY)));   // §A：上限 3/4 屏高
      root.querySelector('.world-view').style.setProperty('--chrono-h', Math.round(h) + 'px');
      sessionStorage.setItem('soliterra.chronoH', String(Math.round(h)));
      chrono.layout();
    };
    const up = () => {
      handle.classList.remove('active');
      bar.classList.remove('no-h-anim');
      chrono.layout();
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

/** 面板宽度拖动：10×60 矩形把手，居中悬浮在边界线上；指针距边界 ≤40px 才显示。 */
function bindPanelResize(ctx, side, cssVar, storeKey) {
  const host = document.getElementById(side === 'left' ? 'panel-left' : 'panel-right');
  const handle = host?.querySelector('#panel-resize');
  if (!handle) return;
  // 靠近边界显示（文档级监听，随面板重建而换绑）
  if (host.__nearEdge) document.removeEventListener('mousemove', host.__nearEdge);
  host.__nearEdge = (e) => {
    const r = host.getBoundingClientRect();
    const edgeX = side === 'left' ? r.right : r.left;
    host.classList.toggle('near-edge', Math.abs(e.clientX - edgeX) <= 40);
  };
  document.addEventListener('mousemove', host.__nearEdge);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = host.getBoundingClientRect().width;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    handle.classList.add('active');
    const move = (ev) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.min(window.innerWidth * 0.6, Math.max(260, startW + delta));
      document.getElementById('shell').style.setProperty(cssVar, Math.round(w) + 'px');
      sessionStorage.setItem(storeKey, Math.round(w) + 'px');
    };
    const up = () => {
      handle.classList.remove('active');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ============ 设置（.soliterra/settings.json，全 CSS 变量） ============
function applySettings(ctx) {
  const s = ctx.settings || {};
  const view = document.querySelector('.world-view');
  if (!view) return;
  // 主题：light / dark / auto
  if (s.theme === 'dark' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
  // 字体档（第 100 轮）：平台级 localStorage + 根级 token 覆写——由 app.js applyGlobalFont 统一应用，此处不再设。
  view.style.setProperty('--reading-size', (s.size || 18) / 16 + 'rem');
  view.style.setProperty('--reading-leading', s.leading || (state.lang === 'en' ? '1.65' : '1.8'));
  view.style.setProperty('--reading-measure', (s.measure || 42) + 'rem');
}

// 设置条目（并入 + 世界面板，自上而下：主题/字体/字号/行高/列宽/语言；不再有独立设置面板）
function settingsRowsHTML() {
  const zh = state.lang === 'zh-CN';
  const segs = [
    ['theme', lt('theme'), [['light', '☀'], ['dark', '☾'], ['auto', '◐']]],
    // 第 100 轮：字体两档（中英文一起切换；mono 档废除）——文本标签可辨识（原三个 Aa 无从区分）
    ['font', lt('font'), [['serif', zh ? '衬线' : 'Serif'], ['sans', zh ? '无衬线' : 'Sans']]],
    ['size', lt('size'), [['16', '16'], ['18', '18'], ['20', '20'], ['22', '22']]],
    ['leading', lt('leading'), [['1.65', '1.65'], ['1.8', '1.8'], ['1.95', '1.95']]],
    ['measure', lt('measure'), [['36', '36'], ['42', '42'], ['48', '48']]],
  ];
  return segs.map(([key, label, opts]) => `
      <div class="set-row"><span class="eyebrow">${label}</span>
        <div class="seg" data-set="${key}">
          ${opts.map(([v, t2]) => `<button data-val="${v}">${t2}</button>`).join('')}
        </div></div>`).join('') + `
      <div class="set-row"><span class="eyebrow">${lt('language')}</span>
        <div class="seg" data-lang></div>
      </div>
      <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '编辑器' : 'Editor'}</span>
        <div class="seg" data-set="editor"><button data-val="std">${state.lang === 'zh-CN' ? '标准' : 'Std'}</button><button data-val="min">${state.lang === 'zh-CN' ? '极简' : 'Min'}</button></div></div>
      <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '时代带' : 'Era band'}</span>
        <div class="seg" data-set="axisEra"><button data-val="on">${state.lang === 'zh-CN' ? '开' : 'On'}</button><button data-val="off">${state.lang === 'zh-CN' ? '关' : 'Off'}</button></div></div>
      <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '保存间隔' : 'Autosave'}</span>
        <div class="seg" data-set="saveDelay"><button data-val="500">0.5s</button><button data-val="1000">1s</button><button data-val="2000">2s</button><button data-val="0">${state.lang === 'zh-CN' ? '关闭' : 'Off'}</button></div></div>`;
}

/** 设置条目接线（即时生效 + 持久化）。 */
function bindSettings(ctx, scope) {
  scope.querySelectorAll('.seg[data-set]').forEach((seg) => {
    const key = seg.dataset.set;
    // 第 100 轮：字体 = 平台级（localStorage + 根级 token，首页/世界/中英文一致）；其余仍存每世界 settings.json
    const cur = key === 'font' ? currentFont() : (ctx.settings[key] ?? seg.querySelector('button')?.dataset.val);
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.val === String(cur));
      b.addEventListener('click', async () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        if (key === 'font') {
          localStorage.setItem('soliterra.font', b.dataset.val);
          applyGlobalFont(b.dataset.val);   // 立即全站生效（中英文一起切）
          return;
        }
        ctx.settings[key] = b.dataset.val;
        applySettings(ctx);
        await api(`/api/w/${enc(ctx.worldId)}/settings`, { method: 'POST', body: { [key]: b.dataset.val } }).catch(() => {});
        if (key === 'axisEra') ctx.chrono?.layout();                     // 时代带：即时重排
      });
    });
  });
  scope.querySelectorAll('[data-lang] button').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.val === state.lang) return;
    const { setLang } = await import('./app.js');
    await setLang(b.dataset.val);
    location.reload();
  }));
}

// ============ 世界面板（左 push：世界信息 + 全部设置条目，自上而下；固定宽不可调） ============
async function renderWorldPanel(ctx) {
  const host = document.getElementById('wp-embed');
  if (!host) return;
  const info = await api(`/api/w/${enc(ctx.worldId)}/stats`).catch(() => ({ entries: 0, events: 0 }));
  const gitInfo = await api(`/api/w/${enc(ctx.worldId)}/git`).catch(() => ({ ok: false }));
  const meta = await api('/api/meta').catch(() => ({ home: '' }));   // 家目录（位置行 ~/… 缩写，第 87 轮）
  const dirFull = info.dir || '';
  const dirShow = dirFull ? abbrevPath(dirFull, meta.home) + '/' : '';
  const rootNode = rootNodeOf(ctx);
  const cover = rootNode?.cover;
  const bookCount = topBookNodes(ctx).filter((c) => c.md || c.children.length).length;

  const siteRel = localStorage.getItem('soliterra.site.' + ctx.worldId) || '';   // 最近一次只读站点（第 86 轮「上次站点 ↗」原生链接）
  host.innerHTML = `
    <button class="wp-back button-ghost" id="wp-back">← ${lt('back')}</button>
    ${cover ? `<div class="wp-banner"><img src="/w/${enc(ctx.worldId)}/${enc(cover)}" alt="" data-glyph="${esc((rootNode?.title || ctx.worldId).slice(0, 1))}" data-glyph-class="wp-glyph"></div>` : ''}
    <div class="wp-head">
      <h2 class="wp-name">${esc(rootNode?.title || ctx.worldId)}</h2>
      <div class="wp-stats">
        <span>${lt('booksN')} ${bookCount}</span>
        <span>${lt('entriesN')} ${info.entries}</span>
      </div>
      <div class="wp-git">${gitInfo.ok ? `${esc(gitInfo.branch)} · ${esc(gitInfo.hash)} · ${esc(gitInfo.when)}` : 'not a git repo'}</div>
    </div>
    <div class="wp-commit-row">
      <span class="wp-dirty" id="wp-dirty"></span>
      <span class="wp-git-btns">
        <button class="button-ghost wp-hist" id="wp-history">${lt('gitHistory')}</button>
        <button class="button-primary wp-commit" id="wp-commit" hidden>${lt('commitNow')}</button>
      </span>
    </div>
    ${dirShow ? `<div class="set-row wp-loc"><span class="eyebrow">${lt('loc')}</span>
      <span class="wp-loc-right"><span class="wp-loc-path" title="${esc(dirFull)}">${esc(dirShow)}</span>
      <button class="button-ghost" id="wp-reveal">Finder ↗</button></span></div>` : ''}
    <div class="set-row"><span class="eyebrow">${lt('dashboard')}</span>
      <button class="button-ghost wp-dash" id="wp-dash">→</button></div>
    <div class="set-row wp-export-row"><span class="eyebrow">${lt('export')}</span>
      <span class="export-btns">
        <button class="button-ghost" id="ex-doc-md">${lt('exDocMd')}</button>
        <button class="button-ghost" id="ex-doc-txt">${lt('exDocTxt')}</button>
        <button class="button-ghost" id="ex-book-md">${lt('exBookMd')}</button>
        <button class="button-ghost" id="ex-book-epub">${lt('exBookEpub')}</button>
        <button class="button-ghost" id="ex-book-pdf">${lt('exBookPdf')}</button>
        <button class="button-ghost" id="ex-book-docx">${lt('exBookDocx')}</button>
        <button class="button-ghost" id="ex-site">${lt('exSite')}</button>${siteRel ? `<a class="button-ghost" id="ex-site-open" href="/w/${enc(ctx.worldId)}/${esc(siteRel)}/index.html" target="_blank" rel="noopener" title="${esc(siteRel)}">${lt('exSiteOpen')}</a>` : ''}
      </span>
    </div>
    <div class="wp-settings-rows">${settingsRowsHTML(ctx)}</div>
    <div class="set-row wp-about"><span class="eyebrow">${lt('about')}</span>
      <span class="about-mono">Soliterra v0.1 · local</span></div>`;
  fillLangSeg(host, state.lang);
  bindSettings(ctx, host);
  host.querySelector('#wp-commit').addEventListener('click', () => commitFlow(ctx));
  host.querySelector('#wp-back').addEventListener('click', () => navigate('#/'));
  host.querySelector('#wp-history').addEventListener('click', () => openGitHistory(ctx));
  host.querySelector('#wp-dash').addEventListener('click', () => openDashboard(ctx));
  host.querySelector('#wp-reveal')?.addEventListener('click', async () => {   // 第 87 轮：在 Finder 中显示
    try { await api('/api/worlds/reveal', { method: 'POST', body: { id: ctx.worldId } }); }
    catch (e) { showToast(String(e.message), 'error'); }
  });
  const top = currentBookOf(ctx) || rootNodeOf(ctx);
  host.querySelector('#ex-doc-md').addEventListener('click', () => exportDoc(ctx, 'md'));
  host.querySelector('#ex-doc-txt').addEventListener('click', () => exportDoc(ctx, 'txt'));
  host.querySelector('#ex-book-md').addEventListener('click', () => exportBook(ctx, 'md', top));
  host.querySelector('#ex-book-epub').addEventListener('click', () => exportBook(ctx, 'epub', top));
  host.querySelector('#ex-book-docx').addEventListener('click', () => exportBook(ctx, 'docx', top));
  host.querySelector('#ex-book-pdf').addEventListener('click', () => exportBook(ctx, 'pdf', top));
  host.querySelector('#ex-site').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/api/w/${enc(ctx.worldId)}/publish`, { method: 'POST', body: {} });
      localStorage.setItem('soliterra.site.' + ctx.worldId, r.rel);   // 供「上次站点 ↗」原生链接（永不被拦）
      renderWorldPanel(ctx);
      showToast(`${lt('siteBuilt')}${r.rel}（${r.pages} ${state.lang === 'zh-CN' ? '页' : 'pages'}${r.hidden ? ` · ${state.lang === 'zh-CN' ? '隐藏' : 'hidden'} ${r.hidden}` : ''}${r.assets ? ` · ${state.lang === 'zh-CN' ? '图片' : 'assets'} ${r.assets}` : ''}）`, 'success', 6000);
      window.open(`/w/${enc(ctx.worldId)}/${enc(r.rel)}/index.html`, '_blank');   // 生成即所见（手势内打开不被拦）
    } catch (e) { showToast(String(e.message), 'error'); }
    btn.disabled = false;
  });
  bindCoverFallbacks(host);
  refreshGitStatus(ctx);
}

// ============ 导出（§15.2）：md / txt / EPUB / PDF 打印 ============
async function exportDoc(ctx, fmt) {
  try {
    const { text } = await api(`/api/w/${enc(ctx.worldId)}/raw?path=${enc(ctx.currentPath)}`);
    const name = (ctx.currentPath || 'entry').split('/').pop().replace(/\.md$/i, '');
    if (fmt === 'txt') download(`${name}.txt`, new Blob(['\ufeff' + mdToTxt(text)], { type: 'text/plain;charset=utf-8' }));
    else download(`${name}.md`, new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    showToast(state.lang === 'zh-CN' ? '已导出' : 'Exported', 'success');
  } catch (e) { showToast(String(e.message), 'error'); }
}

async function exportBook(ctx, fmt, book) {
  if (!book) return;
  const paths = subtreePaths(book);
  if (!paths.length) { showToast(state.lang === 'zh-CN' ? '本书无条目' : 'Empty book', 'warning'); return; }
  const name = book.title || book.name;
  try {
    if (fmt === 'md' || fmt === 'docx') {
      const parts = [];
      for (const p2 of paths) {
        const { text } = await api(`/api/w/${enc(ctx.worldId)}/raw?path=${enc(p2)}`);
        parts.push(text);
      }
      if (fmt === 'docx') {
        download(`${name}.docx`, buildDocx({ title: name, chapters: parts }));
        showToast(`${state.lang === 'zh-CN' ? '已导出' : 'Exported'} DOCX · ${parts.length} §`, 'success');
        return;
      }
      download(`${name}.md`, new Blob([parts.join('\n\n---\n\n')], { type: 'text/markdown;charset=utf-8' }));
      showToast(`${state.lang === 'zh-CN' ? '已导出' : 'Exported'} · ${parts.length} §`, 'success');
      return;
    }
    const chapters = [];
    for (const p2 of paths) {
      const e = await api(`/api/w/${enc(ctx.worldId)}/entry?path=${enc(p2)}`);
      chapters.push({ title: e.title || p2, html: `<div class="meta">${e.rangeHTML || ''}</div>${e.html}` });
    }
    if (fmt === 'epub') {
      // 封面嵌入（第 83 轮；第 92 轮澄清键名）：书籍 &m 封面 → EPUB cover-image；取不到 → 原行为
      let cover = null;
      if (book.cover) {
        try {
          const res = await fetch(`/w/${enc(ctx.worldId)}/${enc(book.cover)}`);
          if (res.ok) {
            const ext = book.cover.match(/\.[a-z0-9]+$/i)?.[0] || '.png';
            cover = { name: `cover${ext}`, bytes: new Uint8Array(await res.arrayBuffer()) };
          }
        } catch { /* 无封面文件 → 不嵌 */ }
      }
      download(`${name}.epub`, buildEpub({ title: name, chapters, cover }));
      showToast(`${state.lang === 'zh-CN' ? '已导出' : 'Exported'} EPUB · ${chapters.length} §`, 'success');
      return;
    }
    if (fmt === 'pdf') {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>
        body{font-family:'Songti SC','Iowan Old Style',serif;max-width:42rem;margin:0 auto;padding:48px 24px;color:#050505;line-height:1.8;font-size:16px}
        h1{font-size:1.4rem;margin:2.4rem 0 .8rem;border-bottom:1px solid #d8d8d8;padding-bottom:6px}
        .meta{font-family:'SFMono-Regular',monospace;font-size:.7rem;color:#666;margin-bottom:8px}
        pre{background:#f4f4f2;border:1px solid #d8d8d8;padding:10px 14px;white-space:pre-wrap;font-size:.85rem}
        img{max-width:100%;border:1px solid #d8d8d8}
        @media print{body{padding:0}}
      </style></head><body>${chapters.map((c) => `<h1>${esc(c.title)}</h1>${c.html}`).join('')}</body></html>`;
      const note = state.lang === 'zh-CN' ? '在打印对话框选「另存为 PDF」' : 'Choose "Save as PDF"';
      const win = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
      if (win) {
        win.onload = () => { win.print(); };
        showToast(note, 'success');
      } else {
        // 弹窗被禁（如内置浏览器）→ 隐藏 iframe 打印：不依赖弹窗权限
        const ifr = document.createElement('iframe');
        ifr.setAttribute('aria-hidden', 'true');
        ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none';
        ifr.srcdoc = html;
        ifr.onload = () => {
          try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch {}
          ifr.addEventListener('afterprint', () => setTimeout(() => ifr.remove(), 5000), { once: true });
        };
        document.body.appendChild(ifr);
        showToast(note, 'success');
      }
    }
  } catch (e) { showToast(String(e.message), 'error'); }
}

// ============ Git 历史纸面（§15.6：提交列表 + 快照 + 回滚为新提交） ============
async function openGitHistory(ctx) {
  const { modal, close, body } = openPaperDialog2('Git · ' + (state.lang === 'zh-CN' ? '历史' : 'History'));
  body.innerHTML = `
    <div class="git-layout">
      <div class="git-list" id="git-list"><div class="loading">…</div></div>
      <div class="git-detail" id="git-detail"><div class="empty-state">${state.lang === 'zh-CN' ? '选择一个提交查看快照' : 'Select a commit'}</div></div>
    </div>`;
  const list = body.querySelector('#git-list');
  const detail = body.querySelector('#git-detail');
  const showEmptyDetail = () => {
    detail.innerHTML = `<div class="empty-state">${state.lang === 'zh-CN' ? '选择一个提交查看快照' : 'Select a commit'}</div>`;
  };
  const loadLog = async () => {
    const zh = state.lang === 'zh-CN';
    const [{ commits }, st] = await Promise.all([
      api(`/api/w/${enc(ctx.worldId)}/git/log`),
      api(`/api/w/${enc(ctx.worldId)}/git/status`).catch(() => ({ dirty: 0, files: [] })),
    ]);
    // 第 94 轮：最新一笔「未提交改动」也作为列表首项——旁边一键提交（默认 update: 时间戳）
    // 第 104 轮：结构与 .git-commit 完全一致（grid 三区 hash/subj/when——用户要求整体样式与历史行同款）；
    // 内嵌提交按钮入 when 位；无 data-rev → 不绑历史快照 click。
    const uncommitted = st.dirty > 0 ? `
      <div class="git-commit git-uncommitted">
        <span class="git-hash">····</span>
        <span class="git-subj">${esc(zh ? `未提交 · ${st.dirty} 个文件` : `Uncommitted · ${st.dirty} files`)}</span>
        <span class="git-when"><button class="git-commit-now">${zh ? '提交' : 'Commit'}</button></span>
      </div>` : '';
    list.innerHTML = uncommitted + (commits.length ? commits.map((c) => `
      <button class="git-commit" data-rev="${esc(c.hash)}">
        <span class="git-hash">${esc(c.hash)}</span>
        <span class="git-subj">${esc(c.subject)}</span>
        <span class="git-when">${esc(c.when)}</span>
      </button>`).join('') : `<div class="empty-state">${zh ? '暂无提交' : 'No commits'}</div>`);
    // 第 96 轮：未提交行本身可点击 → 右侧 detail 列出变更文件（状态字母 + 路径；再点取消选中）
    list.querySelector('.git-uncommitted')?.addEventListener('click', () => {
      const un = list.querySelector('.git-uncommitted');
      const selected = un.classList.contains('on');
      list.querySelectorAll('.git-commit').forEach((x) => x.classList.remove('on'));
      un.classList.toggle('on', !selected);
      if (selected) { showEmptyDetail(); return; }
      detail.innerHTML = `
        <div class="git-file-list">${(st.files || []).map((f) => `
          <div class="git-file is-static"><span class="git-fs ${f.status === 'D' ? 'del' : f.status === 'A' ? 'add' : ''}">${esc(f.status)}</span>${esc(f.path)}</div>`).join('')}</div>
        <div class="empty-state">${zh ? `共 ${st.dirty} 个文件待提交——点上方行内的「提交」按钮直接提交` : `${st.dirty} files pending — use the Commit button on the row`}</div>`;
    });
    list.querySelector('.git-commit-now')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
        await api(`/api/w/${enc(ctx.worldId)}/commit`, { method: 'POST', body: { message: `update: ${ts}` } });
        showToast(zh ? '已提交' : 'Committed', 'success');
        await refreshGitStatus(ctx);
        showEmptyDetail();   // 未提交文件清单已过期 → 复位（第 96 轮）
        await loadLog();   // 未提交项消失，新提交置顶
      } catch (e) { showToast(String(e.message), 'error'); btn.disabled = false; }
    });
    list.querySelectorAll('.git-commit[data-rev]').forEach((b) => b.addEventListener('click', () => {
      list.querySelectorAll('.git-commit').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      showCommit(b.dataset.rev);
    }));
  };
  const showCommit = async (rev) => {
    const { files } = await api(`/api/w/${enc(ctx.worldId)}/git/show?rev=${enc(rev)}`);
    detail.innerHTML = `
      <div class="git-file-list">${files.length ? files.map((f) => `
        <button class="git-file" data-path="${esc(f.path)}"><span class="git-fs ${f.status === 'D' ? 'del' : f.status === 'A' ? 'add' : ''}">${esc(f.status)}</span>${esc(f.path)}</button>`).join('') : '—'}</div>
      <div class="git-file-view" id="git-file-view"></div>
      <div class="git-rollback"><button class="button-primary" id="git-rb">${lt('rollback')}</button></div>`;
    detail.querySelectorAll('.git-file').forEach((b) => b.addEventListener('click', async () => {
      detail.querySelectorAll('.git-file').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const { text } = await api(`/api/w/${enc(ctx.worldId)}/git/file?rev=${enc(rev)}&path=${enc(b.dataset.path)}`);
      detail.querySelector('#git-file-view').textContent = text.slice(0, 20000);
    }));
    // 回滚 = 两步确认（不弹原生 confirm）
    detail.querySelector('#git-rb').addEventListener('click', () => {
      const bar = detail.querySelector('.git-rollback');
      bar.innerHTML = `<span class="git-rollback-q">${lt('rollbackSure')}</span>
        <button class="button-primary" id="git-rb-yes">${lt('rollbackOk')}</button>
        <button class="button-ghost" id="git-rb-no">${lt('rollbackCancel')}</button>`;
      bar.querySelector('#git-rb-no').addEventListener('click', () => { bar.innerHTML = `<button class="button-primary" id="git-rb">${lt('rollback')}</button>`; showCommitBind(rev); });
      bar.querySelector('#git-rb-yes').addEventListener('click', async () => {
        try {
          await api(`/api/w/${enc(ctx.worldId)}/git/rollback`, { method: 'POST', body: { rev } });
          worldDataCache.delete(ctx.worldId);
          showToast(state.lang === 'zh-CN' ? '已回滚（新提交）' : 'Rolled back (new commit)', 'success');
          close();
          refreshGitStatus(ctx);
        } catch (e) { showToast(String(e.message), 'error'); }
      });
    });
    const showCommitBind = (rv) => { const btn = detail.querySelector('#git-rb'); btn?.addEventListener('click', () => showCommit(rv)); };
  };
  await loadLog();
}

/** 语言段（动态：GET /api/locales → 按钮；新语言 = 往 locales/ 放 json 即出现）。 */
async function fillLangSeg(host, langNow) {
  const seg = host.querySelector('[data-lang]');
  if (!seg) return;
  let list = [];
  try { list = await api('/api/locales'); } catch {}
  if (!list.length) list = [{ tag: 'zh-CN', label: '中文' }, { tag: 'en', label: 'English' }];
  seg.innerHTML = list.map((l) => `<button data-val="${esc(l.tag)}" class="${langNow === l.tag ? 'on' : ''}">${esc(l.label)}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.val === langNow) return;
    const { setLang } = await import('./app.js');
    await setLang(b.dataset.val);
    location.reload();
  }));
}

// ============ 未提交状态（世界面板提交行） ============
/** 提交所有改动（世界面板直达，默认信息 update: <时间戳>）。 */
async function commitFlow(ctx) {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const msg = await askText(lt('commitMsg'), `update: ${ts}`);
  if (msg === null) return;
  await api(`/api/w/${enc(ctx.worldId)}/commit`, { method: 'POST', body: { message: msg || `update: ${ts}` } });
  showToast(state.lang === 'zh-CN' ? '已提交' : 'Committed', 'success');
  await refreshGitStatus(ctx);
  // 刷新世界面板 git 行
  const g = await api(`/api/w/${enc(ctx.worldId)}/git`).catch(() => ({ ok: false }));
  const gitEl = document.querySelector('.wp-git');
  if (gitEl && g.ok) gitEl.textContent = `${g.branch} · ${g.hash} · ${g.when}`;
}

// ============ 书籍面板拖拽排序（第 101 轮）：卡片间 pointer 拖动 =同层插入前/后 ============
// 指示线与目录树同语义：落点目标卡**左半 = 插到它前面**（左缘线）、**右半 = 插到它后面**（右缘线）；
// 跨父（旧形态散文件 vs books/ 子卡混排）由 reorderNode 拒绝 → 无指示线不落。
let bookDrag = null;
let bookDragBound = false;

/** 间隙线（第 103 轮）：挂在网格上的独立 2px 竖线，绝对定位于两卡 14px 间隙**正中**
 *  （左线占 [目标左缘−8, −6]、右线占 [右缘+6, +8]——中点即间隙 7px 处）。 */
let bookDropLine = null;
function ensureBookDropLine() {
  if (bookDropLine && bookDropLine.isConnected) return bookDropLine;
  const grid = document.getElementById('books-grid');
  if (!grid) return null;
  if (getComputedStyle(grid).position === 'static') grid.style.position = 'relative';
  bookDropLine = document.createElement('div');
  bookDropLine.className = 'book-drop-line';
  grid.appendChild(bookDropLine);
  return bookDropLine;
}
function showBookDropLine(target, after) {
  const line = ensureBookDropLine();
  if (!line) return;
  const grid = document.getElementById('books-grid');
  const r = target.getBoundingClientRect(), gr = grid.getBoundingClientRect();
  line.style.display = 'block';
  line.style.top = (r.top - gr.top) + 'px';
  line.style.height = r.height + 'px';
  // 间隙 = 卡间 14px：左线中点距目标左缘 7px → left = 左缘 −8（线占 −8..−6，中点 −7）
  line.style.left = (after ? (r.right - gr.left + 6) : (r.left - gr.left - 8)) + 'px';
}
function hideBookDropLine() { if (bookDropLine) bookDropLine.style.display = 'none'; }

function bindBookDrag(card, ctx, node) {
  card.style.cursor = 'grab';
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    bookDrag = { ctx, node, sx: e.clientX, sy: e.clientY, active: false, card };
  });
}

function ensureBookDragGlobal() {
  if (bookDragBound) return;
  bookDragBound = true;
  const clearMarks = () => document.querySelectorAll('.book-card.drop-sibling, .book-card.drop-after').forEach((n) => n.classList.remove('drop-sibling', 'drop-after'));
  document.addEventListener('pointermove', (e) => {
    if (!bookDrag) return;
    if (!bookDrag.active) {
      if (Math.hypot(e.clientX - bookDrag.sx, e.clientY - bookDrag.sy) < 5) return;
      bookDrag.active = true;
      document.body.classList.add('toc-dragging');
      bookDrag.card.style.transform = '';   // 冻结 hover 倾斜，防 ghost/源卡歪着拖
      bookDrag.card.classList.add('dragging-src');   // 源卡原地淡出（占位保持网格不跳）
      const ghost = bookDrag.card.cloneNode(true);
      ghost.className = 'toc-drag-ghost';
      ghost.style.transform = '';
      ghost.style.width = Math.round(bookDrag.card.getBoundingClientRect().width) + 'px';
      document.body.appendChild(ghost);
      bookDrag.ghost = ghost;
      // 第 103 轮：抑制标志**在松手时**才起算（原按下起算 → 拖 >400ms 松手后 click 漏拦 = 拖完进入书籍）
    }
    bookDrag.ghost.style.left = (e.clientX + 10) + 'px';
    bookDrag.ghost.style.top = (e.clientY + 6) + 'px';
    clearMarks();
    hideBookDropLine();
    bookDrag.mode = null; bookDrag.target = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el?.closest?.('.book-card');
    if (target && target !== bookDrag.card && !target.classList.contains('archived') && target.dataset.name) {
      const r = target.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;   // 右半 = 后；左半 = 前（横排阅读顺序）
      target.classList.add(after ? 'drop-after' : 'drop-sibling');
      showBookDropLine(target, after);   // 第 103 轮：独立线悬在两卡间隙正中
      bookDrag.mode = after ? 'after' : 'before';
      bookDrag.target = target;
    }
  });
  document.addEventListener('pointerup', async () => {
    if (!bookDrag) return;
    const d = bookDrag;
    bookDrag = null;
    d.card?.classList.remove('dragging-src');
    if (!d.active) return;
    d.ghost?.remove();
    document.body.classList.remove('toc-dragging');
    clearMarks();
    hideBookDropLine();
    // 第 103 轮：抑制从**松手**起算 400ms——click 在 up 后同帧派发必拦；拖多久都不影响
    window.__tocDragged = true;
    setTimeout(() => { window.__tocDragged = false; }, 400);
    if (!d.target || !d.mode) return;
    const targetName = d.target.dataset.name;
    const targetNode = topBookNodes(d.ctx).find((b) => b.name === targetName);
    if (!targetNode || targetNode === d.node) return;
    await reorderNode(d.ctx, d.node, targetNode, d.mode);   // 同父校验 + 整层 &r 重排 + 重绘（world-tree 导出）
  });
}

// ============ 全部书籍面板（左 push：竖排网格滚动 · 双列起 · hover 倾斜 · 宽可变列数） ============
function renderBooksPanel(ctx) {
  const grid = document.getElementById('books-grid');
  if (!grid) return;
  const count = document.getElementById('books-count');
  const filter = document.getElementById('books-filter');
  const books = topBookNodes(ctx).filter((c) => c.md || c.children.length);
  // 分类 filter（§8.3）：顶层书的 &t 标签去重成 chip 行（旧弹层的分类行迁移）
  const cats = [];
  for (const b of books) for (const tg of (b.tags || [])) if (!cats.includes(tg)) cats.push(tg);
  ctx.booksCat = ctx.booksCat || '全部';
  if (ctx.booksCat !== '全部' && ctx.booksCat !== '归档' && !cats.includes(ctx.booksCat)) ctx.booksCat = '全部';
  // 归档视图（第 90 轮）：书籍面板的「归档」chip——已归档的书与条目在此还原
  if (!ctx.archives) {
    ctx.archives = { books: [], entries: [] };
    api(`/api/w/${enc(ctx.worldId)}/archives`).then((a) => {
      ctx.archives = a;
      if (document.getElementById('books-grid')) renderBooksPanel(ctx);
    }).catch(() => { /* 无归档 */ });
  }
  const archN = (ctx.archives?.books.length || 0) + (ctx.archives?.entries.length || 0);

  function paintGrid() {
    if (ctx.booksCat === '归档') {
      const arch = ctx.archives || { books: [], entries: [] };
      if (count) count.textContent = `${archN}`;
      grid.innerHTML = [
        ...arch.books.map((a) => `
        <button class="book-card archived" data-rel="${esc(a.rel)}" data-kind="book">
          <div class="book-card-cover"><span class="book-card-glyph">${esc((a.title || a.rel).slice(0, 1))}</span></div>
          <div class="book-card-title">${esc(a.title)}</div>
          <div class="book-card-tags eyebrow">${state.lang === 'zh-CN' ? '此书已归档 · 点击还原' : 'Archived book · click to restore'}</div>
        </button>`),
        ...arch.entries.map((a) => `
        <button class="book-card archived" data-rel="${esc(a.rel)}" data-kind="entry">
          <div class="book-card-cover"><span class="book-card-glyph">${esc((a.title || a.rel).slice(0, 1))}</span></div>
          <div class="book-card-title">${esc(a.title)}</div>
          <div class="book-card-tags eyebrow" title="${esc(a.orig)}">${state.lang === 'zh-CN' ? '条目已归档 · 点击还原' : 'Archived entry · click to restore'}</div>
        </button>`),
      ].join('') || `<div class="empty-state">${state.lang === 'zh-CN' ? '暂无归档' : 'No archives'}</div>`;
      grid.querySelectorAll('.book-card.archived').forEach((card) => {
        attachTilt(card);
        card.addEventListener('click', async () => {
          try {
            const r = await api(`/api/w/${enc(ctx.worldId)}/fs/unarchive`, { method: 'POST', body: { rel: card.dataset.rel } });
            ctx.archives = null;
            await refreshTree(ctx);
            showToast(state.lang === 'zh-CN' ? `已还原：${r.restored || r.archived || ''}` : 'Restored', 'success');
          } catch (e) { showToast(String(e.message), 'error'); }
        });
      });
      return;
    }
    const shown = books.filter((b) => ctx.booksCat === '全部' || (b.tags || []).includes(ctx.booksCat));
    if (count) count.textContent = ctx.booksCat === '全部'
      ? `${books.length} ${lt('shelfBooks')}`
      : `${shown.length} / ${books.length} ${lt('shelfBooks')}`;
    grid.innerHTML = shown.map((b) => `
      <button class="book-card" data-name="${esc(b.name)}">
        <div class="book-card-cover">${b.cover
          ? `<img src="/w/${enc(ctx.worldId)}/${enc(b.cover)}" alt="" data-glyph="${esc((b.title || b.name).slice(0, 1))}" data-glyph-class="book-card-glyph">`
          : `<span class="book-card-glyph">${esc((b.title || b.name).slice(0, 1))}</span>`}</div>
        <div class="book-card-title">${esc(b.title || b.name)}</div>
        ${(b.tags || []).length || !b.md ? `<div class="book-card-tags eyebrow"${b.md ? '' : ` title="${state.lang === 'zh-CN' ? '此节点还没有同名条目——右键「补建同名条目」即成为正式书籍（可设标签/封面）' : 'No paired entry yet'}"`}>${b.md
          ? esc((b.tags || []).slice(0, 2).join(' · '))
          : (state.lang === 'zh-CN' ? '未成书 · 右键补建' : 'No entry · right-click')}</div>` : ''}
      </button>`).join('');
    grid.querySelectorAll('.book-card').forEach((card) => {
      attachTilt(card);
      const b = books.find((x) => x.name === card.dataset.name);
      if (b) bindBookDrag(card, ctx, b);   // 第 101 轮：卡片可拖动调序
      card.addEventListener('click', () => {
        if (window.__tocDragged) return;   // 拖拽后的这次 click 不打开书
        const first = b ? firstEntryOf(b) : null;
        if (!first) return;
        // 点书 = 进入该书：切到目录界面（用户要求：书籍 → 目录 的进入流）+ 导航到首个条目。
        // 先切面板再导航：目录体已建好，openEntry 的 renderToc 直接填充；同条目时仅切面板。
        setPanel(ctx, 'toc');
        if (first !== ctx.currentPath) navigate(`#/w/${enc(ctx.worldId)}/${enc(first)}`);
      });
      // 书籍管理（第 79/80 轮）：**右键**为正式入口（复用目录树菜单：重命名/删除/补建同名条目/书内加条目）；
      // 键盘等价 = 卡片聚焦后按「菜单键」或 Shift+F10（不设卡上悬浮按钮——与极简语言一致）
      const openMenu = (e) => { if (b) showTreeMenu(e, ctx, b); };
      card.addEventListener('contextmenu', openMenu);
      card.addEventListener('keydown', (e) => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        openMenu({ preventDefault() {}, clientX: r.left + 24, clientY: r.top + 24 });
      });
    });
    bindCoverFallbacks(grid);
    ensureBookDragGlobal();
  }
  if (filter) {
    const zh2 = state.lang === 'zh-CN';
    const chips = [['全部', zh2 ? '全部' : 'All'], ...cats.map((c) => [c, c]), ...(archN ? [['归档', `${zh2 ? '归档' : 'Archived'} ${archN}`]] : [])];
    filter.hidden = chips.length <= 1;
    filter.innerHTML = chips.map(([val, label]) => `<button class="bf-chip${val === ctx.booksCat ? ' on' : ''}" data-cat="${esc(val)}">${esc(label)}</button>`).join('');
    filter.querySelectorAll('.bf-chip').forEach((b) => b.addEventListener('click', () => {
      ctx.booksCat = b.dataset.cat;
      filter.querySelectorAll('.bf-chip').forEach((x2) => x2.classList.toggle('on', x2 === b));
      paintGrid();
    }));
  }
  paintGrid();
}

// ============ 阅读 ============
async function openEntry(ctx, path, chrono) {
  // 第 85 轮入口闸：编辑态下换条目 → **先原子退出**（把编辑器内容保存回它所属的条目并销毁），
  // 杜绝「currentPath 已切新条目 + 编辑器还是旧文本」的串写（实测曾把 A 的正文写进 B）。
  if (ctx.editing && ctx.editor && path !== ctx.currentPath) {
    await saveEdit(ctx);
    await refreshTimeline(ctx);
    ctx.editing = false;
    if (ctx.editor) { try { ctx.editor.destroy(); } catch {} ctx.editor = null; }
    ctx.editorPath = null;
    setEditFab(ctx, false);
  }
  const seq = ++openSeq;                       // 渲染序号：期间有更新的打开 → 本渲染过期作废
  ctx.currentPath = path;
  const reader = document.getElementById('reader');
  reader.innerHTML = `<div class="loading">${t('world.loading')}</div>`;
  let e;
  try {
    e = await api(`/api/w/${enc(ctx.worldId)}/entry?path=${enc(path)}`);
  }
  catch (err) { reader.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; return; }
  if (seq !== openSeq) return;                 // 过期渲染丢弃（reader 交由更新的那次负责）
  ctx.currentMtime = e.mtime ?? null;          // 乐观锁基准（第 92 轮：/save 时比对磁盘 mtime）

  document.querySelectorAll('.event-flag.open, .span-bar.open').forEach((n) => n.classList.remove('open'));
  const next = nextEntry(ctx.tree, path);
  const prev = prevEntry(ctx.tree, path);

  reader.innerHTML = `
    <article class="entry">
      ${e.topMetaHTML || ''}
      <div class="entry-title-row">
        <h1 class="entry-title">${esc(e.title)}</h1>
        ${e.rangeHTML || ''}
      </div>
      <div class="entry-body">${e.html}</div>
      ${e.backlinks.length ? `<div class="backlinks"><span class="eyebrow">${t('reader.backlinks')}</span>
        ${e.backlinks.map((b) => `<button class="wikilink" data-target="${esc(b)}">${esc(b)}</button>`).join('')}</div>` : ''}
      <nav class="entry-nav">
        ${prev ? `<button class="button-ghost" data-open="${esc(prev.path)}">← ${t('reader.prev')}：${esc(prev.title)}</button>` : ''}
        ${next ? `<button class="button-ghost" data-open="${esc(next.path)}">${t('reader.next')}：${esc(next.title)} →</button>` : ''}
      </nav>
    </article>`;

  reader.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => navigate(`#/w/${enc(ctx.worldId)}/${enc(b.dataset.open)}`)));
  // 元数据浅字：点击编辑（改 & 行 → 保存 → 刷新）
  ctx.currentRaw = e.raw;
  reader.querySelectorAll('.m-item[data-key]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.key;
    const cur = (e.meta[key] || []).join(' ') || '';
    const val = await openMetaEditor(ctx, key, cur);   // §5.3 结构化控件（日期掩码/标签点选/枚举下拉/自由输入）
    if (val === null) return;
    await editMetaValue(ctx, key, val.trim());
  }));
  reader.querySelectorAll('a.wikilink, button.wikilink').forEach((a) => {
    a.addEventListener('click', async () => {
      const target = a.dataset.target;
      const r = await api(`/api/w/${enc(ctx.worldId)}/resolve?target=${enc(target)}`);
      if (r.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r.path)}`);
      else a.classList.add('missing');
    });
    // hover → 预览卡（220ms 延迟；进卡保持，离开缩回）。
    // 第 91 轮：目标不存在 → 缺条目卡（「创建文件」按钮，生成到世界根目录）；await 期间指针已移开 → 不弹。
    let targetPath = a.dataset.resolved || null;
    a.addEventListener('mouseenter', async () => {
      const rect = a.getBoundingClientRect();
      if (!targetPath) {
        if (a.dataset.missing === '1') { showLinkCard(ctx, a.dataset.target, rect, 0, { missing: a.dataset.target }); return; }
        const r = await api(`/api/w/${enc(ctx.worldId)}/resolve?target=${enc(a.dataset.target)}`).catch(() => null);
        if (!a.matches(':hover')) return;   // resolve 往返期间指针已离开 → 放弃本次悬浮
        if (r?.path) { targetPath = r.path; a.dataset.resolved = r.path; }
        else { a.dataset.missing = '1'; showLinkCard(ctx, a.dataset.target, rect, 0, { missing: a.dataset.target }); return; }
      }
      showLinkCard(ctx, targetPath, rect, 220, { refuted: a.dataset.refuted === '1' });
    });
    a.addEventListener('mouseleave', () => leaveAnchor());
  });
  // 图片点击放大（§B.5）：大图纸面
  reader.querySelectorAll('.entry-body img, .embed-block img').forEach((im) => {
    im.style.cursor = 'zoom-in';
    im.addEventListener('click', (ev) => { ev.preventDefault(); openImagePaper(im.getAttribute('src') || ''); });
  });

  // 目录：换书 → 重建树；同书 → 只移动高亮行（不重建，避免面板闪动）
  const topOf2 = (p2) => topOfPath(p2);
  // 时间轴范围切换：**打开创世条目不动时间轴分毫**（无时间语义）；仅打开非创世条目且换书才切
  if (chrono && !chrono.isGenesis?.(path) && ctx.scopeTop !== topOf2(path)) {
    ctx.scopeTop = topOf2(path);
    chrono.setScope();
  }
  if (chrono) chrono.layout();                                 // 打开条目不取景（用户要求：无自动缩放）
  if (ctx.tree && !ctx.panelPainted) {
    if (ctx.lastTocTop && ctx.lastTocTop !== topOf2(path)) renderToc(ctx);
    else updateTocCurrent(ctx, path);
  }
  ctx.panelPainted = false;
  ctx.lastTocTop = topOf2(path);
  attachScrollIndicators(document.getElementById('reader')?.parentElement || document);
  // 关系图开着 → 清除旧条目相关、以新文档为中心重算
  if (ctx.panel === 'rel') renderRel(ctx);
  // 稍后阅读卡片集：只切换高亮，不重建
  document.querySelectorAll('.rlf-card').forEach((c) => c.classList.toggle('open', c.dataset.path === path));
  annotateCurrent(ctx);   // 工具箱跳转：把错误处框起来（存在 goto 状态时）
  const readerCol = document.getElementById('reader');
  // 进度记忆（§4.2）：恢复已存滚动位置；无记录从头开始
  let savedScroll = 0;
  try { savedScroll = parseInt(localStorage.getItem(`soliterra.scroll.${ctx.worldId}.${path}`) || '0', 10) || 0; } catch {}
  readerCol.scrollTop = savedScroll;
}

/** 缺条目卡「创建文件」（第 91 轮）：双链指向的条目不存在 → 在世界**根目录**下生成 `<目标>.md` 并打开
 *  （捕获语义：平台常规建条目仍走书籍面板/目录/⌘K——根目录散条目随后可经工具箱「结构规范化」迁入 books/）。
 *  目标其实已存在（悬浮负缓存过期）→ 直接打开不重复建。失败抛出 → 卡片按钮复位。 */
async function createMissingEntry(ctx, target) {
  const zh = state.lang === 'zh-CN';
  try {
    const r = await api(`/api/w/${enc(ctx.worldId)}/resolve?target=${enc(target)}`);
    if (r.path) { navigate(`#/w/${enc(ctx.worldId)}/${enc(r.path)}`); return r.path; }
    const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: '', name: target, pair: false } });
    await refreshTree(ctx);
    refreshGitStatus(ctx);
    if (r2.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r2.path)}`);
    showToast(zh ? `已创建：${target}` : `Created: ${target}`, 'success');
    return r2.path;
  } catch (e) {
    showToast(String(e.message), 'error');
    throw e;
  }
}

// ============ 编辑（功能设计 §5 B 档：CM6 简化编辑器 + 装饰层；退出 = 一次 git 提交） ============
let editorModulePromise = null;
function loadEditor() {
  if (!editorModulePromise) editorModulePromise = import('/js/vendor/soliterra-editor.js');
  return editorModulePromise;
}

async function enterEdit(ctx) {
  ctx.editing = true;
  const snapPath = ctx.currentPath;            // 归属快照：编辑器内容属于这个条目（防后续 currentPath 漂移）
  const entryTitle = document.querySelector('.entry-title')?.textContent || snapPath.split('/').pop().replace(/\.md$/i, '');
  const { text, mtime } = await api(`/api/w/${enc(ctx.worldId)}/raw?path=${enc(snapPath)}`);
  ctx.currentMtime = mtime ?? ctx.currentMtime ?? null;   // 乐观锁基准与打开时对齐
  ctx.editorPath = snapPath;
  const saveMs = Number(ctx.settings?.saveDelay ?? 500) || 0;   // 状态条初始保存态（§5 状态条）
  const initialSave = saveMs > 0
    ? (state.lang === 'zh-CN' ? `自动保存 · ${(saveMs / 1000).toFixed(1).replace(/\.0$/, '')}s` : `Autosave · ${(saveMs / 1000).toFixed(1)}s`)
    : (state.lang === 'zh-CN' ? '自动保存已关 · 退出时保存' : 'Autosave off · saved on exit');
  const reader = document.getElementById('reader');
  // 极简编辑器（A 档降级，「更多设置 → 编辑器：极简」）：纯 textarea，无装饰层/工具栏
  if ((ctx.settings?.editor || 'std') === 'min') {
    reader.innerHTML = `
      <div class="editor-shell">
        <div class="meta-drawer" id="meta-drawer"></div>
        <div class="editor-min-note eyebrow">${state.lang === 'zh-CN' ? '极简编辑器 · 纯文本（无装饰层）' : 'Minimal editor · plain markdown'}</div>
        <textarea class="editor-min" id="editor-min" spellcheck="false"></textarea>
      </div>`;
    const ta = reader.querySelector('#editor-min');
    ta.value = text;
    const drawerD = debounce(() => renderMetaDrawer(ctx), 300);
    ctx.editor = {
      getValue: () => ta.value,
      setValue: (t) => { ta.value = t; ta.dispatchEvent(new Event('input')); },
      insertMetaLine: (k) => { ta.value = insertMetaIntoText(ta.value, k); ta.dispatchEvent(new Event('input')); ta.focus(); },
      destroy: () => ta.remove(),
    };
    ta.addEventListener('input', () => { scheduleAutoSave(ctx); drawerD(); });
    ta.focus();
    setEditFab(ctx, true);
    renderMetaDrawer(ctx);
    return;
  }
  reader.innerHTML = `
    <div class="editor-shell">
      <div class="meta-drawer" id="meta-drawer"></div>
      <div class="editor-toolbar" id="editor-toolbar">
        <button class="icon-button" data-cmd="h1">H1</button>
        <button class="icon-button" data-cmd="h2">H2</button>
        <button class="icon-button" data-cmd="h3">H3</button>
        <span class="tb-sep"></span>
        <button class="icon-button" data-cmd="bold"><b>B</b></button>
        <button class="icon-button" data-cmd="italic"><i>I</i></button>
        <button class="icon-button" data-cmd="code">&#96;x&#96;</button>
        <button class="icon-button" data-cmd="quote">&gt;</button>
        <button class="icon-button" data-cmd="list">-</button>
        <span class="tb-sep"></span>
        <button class="icon-button" data-cmd="wikilink">[[ ]]</button>
        <button class="icon-button" data-cmd="fence">▤</button>
        <button class="icon-button" data-cmd="meta">&amp;</button>
        <button class="icon-button" data-cmd="image">▣</button>
        <span class="tb-sep"></span>
        <button class="icon-button" data-cmd="preview" title="${state.lang === 'zh-CN' ? '实时预览分屏（§B.3）' : 'Split preview'}">◐</button>
      </div>
      <div class="editor-host" id="editor-host"></div>
    </div>`;
  await loadEditor();
  window.__soliterraImgClick = (url, label) => openImagePaper(url, label);   // 编辑器缩略图 → 大图纸面
  window.__soliterraToast = (msg, kind) => showToast(msg, kind);
  const drawerD = debounce(() => renderMetaDrawer(ctx), 300);       // 抽屉重扫（§B.2 文档改动 300ms）
  ctx.editor = window.SoliterraEditor.create(document.getElementById('editor-host'), {
    doc: text,
    onChange: (t) => {
      scheduleAutoSave(ctx); drawerD(t);
      if (document.querySelector('.editor-shell.split')) ctx.__previewDeb?.(t);   // §B.3.4 分屏开着才请求
    },
    // 第 98 轮：点正文 & 行不再弹键编辑卡——光标就地直接编辑（改字/删行都自由，&n 可有可无）；
    // 结构化入口保留在抽屉 chips（含删除键）与阅读态元数据浅字。
    getEntries: () => flattenTree(ctx.tree),   // [[ 触发双链补全
    lang: state.lang,                                              // §B.4 菜单文案语言
    uploadAsset: (file) => uploadAsset(ctx, file),                             // 粘贴/拖入上传（§B.5）
    resolveAsset: (src) => (/^(https?:)?\/\//.test(src) || src.startsWith('/') ? src : `/w/${enc(ctx.worldId)}/${enc(src)}`),
  });
  const host = document.getElementById('editor-host');
  new ResizeObserver(() => ctx.editor?.requestMeasure?.()).observe(host);   // 分屏宽度变化 → CM 重排

  // 工具栏接线
  document.getElementById('editor-toolbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    const ed = ctx.editor;
    if (!ed) return;
    if (cmd === 'wikilink') {
      ed.openWikiLink();   // 插入 [[ 并立即弹出条目补全
    } else if (cmd === 'fence') {
      const kind = await askText('围栏类型 event/rel/term/scene/passage', 'event');
      ed.fence(['event', 'rel', 'term', 'scene', 'passage'].includes(kind) ? kind : 'event');
    } else if (cmd === 'meta') {
      const key = await askText('元数据键 s/e/t/f/n/a/p/v/q/m', 'n');
      ed.meta(/^[a-z]$/.test(key || '') ? key : 'n');
    } else if (cmd === 'image') {
      const picked = await openAssetPicker(ctx);   // §B.5 assets 选择纸面（缩略图网格 + 上传）
      if (picked) ed.image(picked.path, picked.alt);
    } else if (cmd === 'preview') {
      toggleEditorPreview(ctx);                    // §B.3.4 实时预览分屏
      updateEditorCount(ctx);
      return;
    } else if (typeof ed[cmd] === 'function') {
      ed[cmd]();
    }
    updateEditorCount(ctx);
  });
  setEditFab(ctx, true);
  mountEditStatus(entryTitle, initialSave);   // 顶缘状态条（第 86 轮）
  renderMetaDrawer(ctx);       // 抽屉初始渲染（§B.2）
}

/** §B.3.4 实时预览分屏：工具栏 ◐ toggle → grid 两栏；输入 400ms 防抖 → POST /render（只读）回填。 */
function toggleEditorPreview(ctx) {
  const shell = document.querySelector('.editor-shell');
  if (!shell) return;
  const on = !shell.classList.contains('split');
  shell.classList.toggle('split', on);
  shell.querySelector('[data-cmd="preview"]')?.classList.toggle('active', on);
  if (!on) return;
  let pane = shell.querySelector('#editor-preview');
  if (!pane) {
    pane = document.createElement('div');
    pane.className = 'editor-preview';
    pane.id = 'editor-preview';
    shell.appendChild(pane);
    ctx.__previewDeb = debounce(() => renderPreviewNow(ctx), 400);
  }
  renderPreviewNow(ctx);
  ctx.editor?.requestMeasure?.();
}

async function renderPreviewNow(ctx) {
  const pane = document.getElementById('editor-preview');
  if (!pane || !pane.isConnected || !document.querySelector('.editor-shell.split')) return;
  try {
    const r = await api(`/api/w/${enc(ctx.worldId)}/render`, { method: 'POST', body: { text: ctx.editor?.getValue() || '' } });
    pane.innerHTML = `${r.topMetaHTML || ''}<div class="entry-title-row"><h1 class="entry-title">${esc(r.title || '')}</h1>${r.rangeHTML || ''}</div><div class="entry-body">${r.html}</div>`;
  } catch (e) { pane.innerHTML = `<div class="empty-state">${esc(String(e.message))}</div>`; }
}

/** 右下编辑 fab：阅读态 = 铅笔细线图标；编辑态 = 保存图标（「保存并退出」）。 */
function setEditFab(ctx, editing) {
  const fab = document.getElementById('fab-edit');
  if (!fab) return;
  fab.innerHTML = editing ? ICON.save : ICON.pencil;
  fab.title = editing ? t('reader.saveExit') : t('reader.edit');
  fab.classList.toggle('active', editing);
}

/** 编辑态顶缘状态条（第 86 轮 §5 规格：24px 内嵌主区顶缘 + 发丝线 + 「编辑中」眉题）。 */
function mountEditStatus(title, initialSaveText) {
  const shell = document.querySelector('.editor-shell');
  if (!shell || document.getElementById('edit-status')) return;
  shell.insertAdjacentHTML('afterbegin',
    `<div class="edit-status" id="edit-status"><span class="es-phase">${state.lang === 'zh-CN' ? '编辑中' : 'Editing'}</span><span class="es-title"></span><span class="es-save"></span></div>`);
  const t = shell.querySelector('.es-title');
  if (t) t.textContent = title ? `· ${title}` : '';
  setEditStatus(initialSaveText || '');
}
/** 保存态文案（autoSave/scheduleAutoSave 调用；状态条不在则 no-op）。 */
function setEditStatus(text) {
  const el = document.getElementById('edit-status')?.querySelector('.es-save');
  if (el) el.textContent = text;
}

/** 统一保存入口（第 92 轮）：baseMtime 乐观锁；409 → 确认弹层「覆盖外部修改？」——绝不静默覆盖。
 *  autoSave 冲突只提示一次（conflictAcked 后静默）；显式保存/退出必问。返回是否已落盘。 */
async function saveEntryText(ctx, rel, text, { prompt = false } = {}) {
  const zh = state.lang === 'zh-CN';
  try {
    const r = await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: rel, text, baseMtime: ctx.currentMtime ?? null, force: false } });
    ctx.currentMtime = r.mtime ?? ctx.currentMtime;
    ctx.conflictAcked = false;
    return true;
  } catch (e) {
    if (e.status !== 409) { showToast(String(e.message), 'error'); setEditStatus(zh ? '保存失败' : 'Save failed'); return false; }
    setEditStatus(zh ? '外部修改冲突' : 'Conflict');
    if (!prompt && ctx.conflictAcked) return false;
    const cover = await confirmModal(zh ? '文件已被外部修改' : 'File changed externally',
      zh ? `「${rel.split('/').pop()}」在磁盘上被外部程序（如 Obsidian）改写过。覆盖外部修改，还是放弃本次保存（外部版本保留在磁盘上）？`
         : `"${rel.split('/').pop()}" was rewritten on disk by an external program. Overwrite it, or discard this save (the external version stays)?`,
      zh ? '覆盖外部修改' : 'Overwrite', zh ? '放弃本次保存' : 'Discard');
    ctx.conflictAcked = true;
    if (!cover) return false;
    try {
      const r = await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: rel, text, force: true } });
      ctx.currentMtime = r.mtime ?? ctx.currentMtime;
      showToast(zh ? '已覆盖外部修改' : 'Overwrote external changes', 'warning');
      return true;
    } catch (e2) { showToast(String(e2.message), 'error'); return false; }
  }
}

/** 自动保存调度（§「保存间隔」设置：500/1000/2000ms 或 0=仅保存并退出时落盘）——动态读取，即时生效。 */
let saveTimer = null;
function scheduleAutoSave(ctx) {
  clearTimeout(saveTimer);
  const ms = Number(ctx.settings?.saveDelay ?? 500) || 0;
  if (ms <= 0) return;
  setEditStatus(state.lang === 'zh-CN' ? '待保存…' : 'Unsaved…');
  saveTimer = setTimeout(() => autoSave(ctx), ms);
}

/** 防抖自动保存（不提交，静默）——保存后立即刷新时间轴（改 &s/&e 即刻上轴、范围随之更新）。 */
async function autoSave(ctx) {
  if (!ctx.editing || !ctx.editor) return;
  const ok = await saveEntryText(ctx, ctx.editorPath || ctx.currentPath, ctx.editor.getValue());
  if (ok) {
    await refreshTimeline(ctx);
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    setEditStatus(state.lang === 'zh-CN' ? `已保存 · ${ts}` : `Saved · ${ts}`);
  }
}

async function saveEdit(ctx) {
  if (!ctx.editor) return false;
  // path 取编辑器归属（第 85 轮保险）：即便状态漂移，内容也只写回它所属条目，永不串写
  return saveEntryText(ctx, ctx.editorPath || ctx.currentPath, ctx.editor.getValue(), { prompt: true });
}

async function exitEdit(ctx) {
  // 退出并保存（不提交——改动累计为未提交，提交在 + 面板）；冲突时用户选择「放弃」→ 留在编辑态
  const saved = await saveEdit(ctx);
  if (!saved) return;
  await refreshTimeline(ctx);   // 编辑期改动（含 & 行）立即反映到时间轴与范围
  ctx.editing = false;
  if (ctx.editor) { try { ctx.editor.destroy(); } catch {} ctx.editor = null; }
  ctx.editorPath = null;
  setEditFab(ctx, false);
  await openEntry(ctx, ctx.currentPath, ctx.chrono);
}

// ============ ⌘K 搜索 ============
function openSearch(ctx) {
  const modal = document.createElement('div');
  modal.className = 'reader-modal active';
  modal.innerHTML = `
    <div class="modal-dialog search-dialog">
      <input class="text-input search-input" placeholder="${t('search.placeholder')}" autofocus>
      <div class="search-results"></div>
    </div>`;
  document.body.appendChild(modal);
  const input = modal.querySelector('.search-input');
  const results = modal.querySelector('.search-results');
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      const rows = await api(`/api/w/${enc(ctx.worldId)}/search?q=${enc(q)}`);
      results.innerHTML = rows.length ? rows.map((r) => `
        <button class="entry-card search-row" data-path="${esc(r.path)}">
          <span class="entry-card-title">${esc(r.title)}</span>
          <span class="entry-card-snip">${r.snip || ''}</span>
        </button>`).join('') : `<div class="empty-state">${t('search.empty')}</div>`;
      results.querySelectorAll('.search-row').forEach((b) => b.addEventListener('click', () => {
        close();
        navigate(`#/w/${enc(ctx.worldId)}/${enc(b.dataset.path)}`);
      }));
      renderActions(ctx, results, q, close);   // ⌘K 动作行（日期取景/稍后阅读/工具/仪表盘）
    }, 160);
  });
}


// ============ ⌘K 动作类：日期取景 / 稍后阅读 / 工具箱 / 仪表盘 ============
/** 输入是否像日期（705 / 705.09 / 705.09.10 / 前300 / -0300.*.*）。 */
function parseDateQuery(q) {
  const s2 = String(q).trim();
  let m = s2.match(/^(前|公元前)?(\d{1,4})\.(\d{1,2}|\*)\.(\d{1,2}|\*)$/);
  if (m) return { ord: parseOrd(`${m[1] ? '-' : ''}${m[2].padStart(4, '0')}.${m[3] === '*' ? '*' : m[3].padStart(2, '0')}.${m[4] === '*' ? '*' : m[4].padStart(2, '0')}`), span: 60 };
  m = s2.match(/^(前|公元前)?(\d{1,4})\.(\d{1,2}|\*)$/);
  if (m) return { ord: parseOrd(`${m[1] ? '-' : ''}${m[2].padStart(4, '0')}.${m[3] === '*' ? '*' : m[3].padStart(2, '0')}.*`), span: 200 };   /* 三段：年.月.* */
  m = s2.match(/^(前|公元前)?(\d{1,4})$/);
  if (m) return { ord: parseOrd(`${m[1] ? '-' : ''}${m[2].padStart(4, '0')}.*.*`), span: 100 };
  return null;
}

function renderActions(ctx, results, q, close) {
  const acts = [];
  const dq = q ? parseDateQuery(q) : null;
  if (dq && dq.ord != null) {
    acts.push(`<button class="entry-card action-row" data-act="date" data-ord="${dq.ord}" data-span="${dq.span}">
      <span class="entry-card-title">${lt('dashJump')} ${esc(q.trim())}</span></button>`);
  }
  if (q && q.trim()) {
    acts.push(`<button class="entry-card action-row" data-act="later" data-q="${esc(q.trim())}">
      <span class="entry-card-title">✦ ${lt('dashLater')} · ${esc(q.trim())}</span></button>`);
  }
  if (q && q.trim() && !parseDateQuery(q)) {
    acts.push(`<button class="entry-card action-row" data-act="newentry" data-q="${esc(q.trim())}">
      <span class="entry-card-title">＋ ${state.lang === 'zh-CN' ? '新建条目' : 'New entry'} · ${esc(q.trim())}</span></button>`);
  }
  acts.push(`<button class="entry-card action-row" data-act="tools"><span class="entry-card-title">🧰 ${lt('dashTools')}</span></button>`);
  acts.push(`<button class="entry-card action-row" data-act="dash"><span class="entry-card-title">📊 ${lt('dashboard')}</span></button>`);
  acts.push(`<button class="entry-card action-row" data-act="map"><span class="entry-card-title">🗺 ${lt('dashMap')}</span></button>`);
  const html = acts.join('');
  results.insertAdjacentHTML('afterbegin', html);
  results.querySelectorAll('.action-row').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    close();
    if (act === 'date') {
      ctx.chrono?.focusOrd(+b.dataset.ord, +b.dataset.span);
      showToast(`${lt('dashJump')} ${q.trim()}`, 'success');
    } else if (act === 'later') {
      const target = b.dataset.q;
      const r = await api(`/api/w/${enc(ctx.worldId)}/resolve?target=${enc(target)}`);
      if (r.path) { await addReadlater(ctx, r.path); }
      else showToast(state.lang === 'zh-CN' ? `无此条目：${target}` : `Not found: ${target}`, 'warning');
    } else if (act === 'newentry') {
      const name = b.dataset.q;
      const book = currentBookOf(ctx);
      if (!book?.dir) { showToast(state.lang === 'zh-CN' ? '世界根只放 README 与 books/——请先打开某本书' : 'Open a book first', 'warning'); return; }
      try {
        const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: book.dir, name, pair: false } });
        await refreshTree(ctx);
        refreshGitStatus(ctx);
        if (r2.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r2.path)}`);
        showToast(state.lang === 'zh-CN' ? `已新建：${name}` : `Created: ${name}`, 'success');
      } catch (e2) { showToast(String(e2.message), 'error'); }
    } else if (act === 'tools') {
      setPanel(ctx, ctx.panel === 'tools' ? '' : 'tools');
    } else if (act === 'dash') {
      openDashboard(ctx);
    } else if (act === 'map') {
      openMapPlaceholder();
    }
  }));
}

// ============ 仪表盘（功能设计 §15.4：条目/双链/标签/深度/警报/git 一览） ============
// ============ 地图占位（§14：⌘K → 地图；待外部编辑器定型后接入热点渲染） ============
function openMapPlaceholder() {
  const { body } = openPaperDialog2('🗺 ' + lt('dashMap'));
  body.innerHTML = `
    <div class="empty-state">
      <div class="eyebrow">${state.lang === 'zh-CN' ? '地图 · 敬请期待' : 'Map · Coming soon'}</div>
      <p>${state.lang === 'zh-CN'
        ? '接入契约已备：外部编辑器导出 assets/maps/*.png + hotspots.json（热区 → 条目）；或以 iframe 嵌入（?world=&pin=）回传热区参数。'
        : 'Contract ready: external editor exports assets/maps/*.png + hotspots.json (hotspots → entries), or iframe embed (?world=&pin=).'}</p>
    </div>`;
}

// ============ 图片管线（§B.5）：上传 / 选择器 / 大图纸面 ============
/** 上传图片文件 → assets/imported/（重名加序号）；返回相对路径。 */
async function uploadAsset(ctx, file) {
  const r = await fetch(`/api/w/${enc(ctx.worldId)}/asset?name=${enc(file.name || 'image.png')}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `上传失败（${r.status}）`);
  showToast(state.lang === 'zh-CN' ? `已上传：${data.path}` : `Uploaded: ${data.path}`, 'success');
  return data.path;
}

/** assets 图片选择纸面：缩略图网格 + 过滤 + 上传；点选返回 {path, alt}，关闭返回 null。 */
function openAssetPicker(ctx) {
  return new Promise((resolve) => {
    const { close, body } = openPaperDialog2('▣ ' + (state.lang === 'zh-CN' ? '插入图片' : 'Insert image'));
    body.innerHTML = `
      <div class="asset-picker">
        <div class="asset-bar">
          <input class="text-input" id="asset-filter" placeholder="${state.lang === 'zh-CN' ? '过滤文件名…' : 'Filter…'}">
          <label class="button-ghost asset-upload" for="asset-file">${state.lang === 'zh-CN' ? '上传图片' : 'Upload'}</label>
          <input type="file" id="asset-file" accept="image/*" hidden>
        </div>
        <div class="asset-grid" id="asset-grid"><div class="loading">…</div></div>
      </div>`;
    let items = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const grid = body.querySelector('#asset-grid');
    const paint = () => {
      const q = (body.querySelector('#asset-filter').value || '').toLowerCase();
      const shown = items.filter((it) => it.path.toLowerCase().includes(q));
      grid.innerHTML = shown.length ? shown.map((it) => `
        <button class="asset-cell" data-path="${esc(it.path)}" title="${esc(it.path)}">
          <img src="/w/${enc(ctx.worldId)}/${enc(it.path)}" alt="" loading="lazy">
          <span class="asset-name">${esc(it.path.split('/').pop())}</span>
        </button>`).join('') : `<div class="empty-state">${state.lang === 'zh-CN' ? 'assets/ 里还没有图片——点「上传图片」' : 'No images yet — use Upload'}</div>`;
      grid.querySelectorAll('.asset-cell').forEach((b) => b.addEventListener('click', () => {
        const p2 = b.dataset.path;
        finish({ path: p2, alt: p2.split('/').pop().replace(/\.[a-z0-9]+$/i, '') });
        close();
      }));
    };
    api(`/api/w/${enc(ctx.worldId)}/assets`).then((r) => { items = r.items || []; paint(); }).catch(() => paint());
    body.querySelector('#asset-filter').addEventListener('input', paint);
    body.querySelector('#asset-file').addEventListener('change', async (e2) => {
      const f = e2.target.files?.[0];
      if (!f) return;
      try {
        const p2 = await uploadAsset(ctx, f);
        finish({ path: p2, alt: (f.name || '').replace(/\.[a-z0-9]+$/i, '') });
        close();
      } catch (err) { showToast(String(err.message), 'error'); }
    });
    const modal = body.closest('.reader-modal');
    const obs = new MutationObserver(() => {
      if (!document.body.contains(modal)) { obs.disconnect(); finish(null); }
    });
    obs.observe(document.body, { childList: true });
  });
}

/** 大图纸面（§B.5）：编辑器缩略图 / 阅读态图片点击共用。 */
function openImagePaper(url, label = '') {
  const title = label || (state.lang === 'zh-CN' ? '图片' : 'Image');
  const { body } = openPaperDialog2('▣ ' + title);
  body.innerHTML = `<div class="img-paper"><img src="${esc(url)}" alt="${esc(label)}"></div>`;
}

async function openDashboard(ctx) {
  const { close, body } = openPaperDialog2('📊 ' + lt('dashboard'));
  body.innerHTML = `<div class="dash-loading loading">…</div>`;
  try {
    const d = await api(`/api/w/${enc(ctx.worldId)}/dashboard`);
    const span = ctx.timeline.length
      ? `${ctx.timeline[0].start} → ${ctx.timeline[ctx.timeline.length - 1].end || ctx.timeline[ctx.timeline.length - 1].start}`
      : '—';
    body.innerHTML = `
      <div class="dash-grid">
        <div class="dash-card"><span class="eyebrow">${lt('entriesN')}</span><b>${d.entries}</b></div>
        <div class="dash-card"><span class="eyebrow">${lt('booksN')}</span><b>${d.books}</b></div>
        <div class="dash-card"><span class="eyebrow">${state.lang === 'zh-CN' ? '双链' : 'Links'}</span><b>${d.links}</b><small>${d.entries ? (d.links / d.entries).toFixed(2) : '0'} ${state.lang === 'zh-CN' ? '条/条目' : '/entry'}</small></div>
        <div class="dash-card"><span class="eyebrow">${state.lang === 'zh-CN' ? '树深度' : 'Depth'}</span><b>${d.maxDepth}</b></div>
        <div class="dash-card"><span class="eyebrow">${state.lang === 'zh-CN' ? '悬空' : 'Dangling'}</span><b class="${d.dangling ? 'warn' : ''}">${d.dangling}</b></div>
        <div class="dash-card"><span class="eyebrow">${state.lang === 'zh-CN' ? '孤立' : 'Isolated'}</span><b class="${d.isolated ? 'warn' : ''}">${d.isolated}</b></div>
        <div class="dash-card"><span class="eyebrow">${state.lang === 'zh-CN' ? '近7天提交' : 'Commits 7d'}</span><b>${d.commitsWeek}</b></div>
        <div class="dash-card"><span class="eyebrow">${state.lang === 'zh-CN' ? '时间轴跨度' : 'Timeline'}</span><b class="dash-span">${esc(span)}</b></div>
      </div>
      <div class="dash-tags"><span class="eyebrow">${state.lang === 'zh-CN' ? '标签覆盖 Top' : 'Tags Top'}</span>
        ${d.tags.length ? d.tags.map((t2) => `<span class="dash-tag"><i style="width:${Math.round((t2.n / d.tags[0].n) * 100)}%"></i><em>${esc(t2.t)}</em><b>${t2.n}</b></span>`).join('') : '—'}
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">${esc(String(e.message))}</div>`;
  }
}

// ============ 工具箱跳转批注：打开条目并把错误处框起来（类似批注） ============
function openWithAnnotation(ctx, path, rawLine) {
  const needle = String(rawLine || '').replace(/^\s*&[a-z]\s+/, '').trim();
  sessionStorage.setItem('soliterra.goto', JSON.stringify({ path, needle: needle.slice(0, 60) }));
  if (ctx.currentPath === path) annotateCurrent(ctx);
  else navigate(`#/w/${enc(ctx.worldId)}/${enc(path)}`);
}

/** 在当前已渲染的条目里找含 needle 片段的元素并框住（找不到则退回标题/元数据行）。 */
function annotateCurrent(ctx) {
  const g = JSON.parse(sessionStorage.getItem('soliterra.goto') || 'null');
  if (!g) return;
  sessionStorage.removeItem('soliterra.goto');
  const entry = document.querySelector('.entry');
  if (!entry) return;
  const frag = (g.needle || '').slice(0, 12);
  let hit = null;
  if (frag) {
    const walk = (el2) => {
      for (const n of el2.childNodes) {
        if (n.nodeType === 3 && n.textContent.includes(frag)) { hit = n.parentElement; return; }
        if (n.nodeType === 1) { walk(n); if (hit) return; }
      }
    };
    walk(entry);
  }
  const target = (hit && hit !== entry) ? hit : (entry.querySelector('.entry-meta-top') || entry.querySelector('.entry-title') || entry);
  target.classList.add('doc-annotation');
  target.scrollIntoView({ block: 'center', behavior: 'auto' });
  setTimeout(() => target.classList.remove('doc-annotation'), 4000);
}

// ============ 工具箱（右 push 面板：扫描 → diff-row 预览 → 应用） ============
/** 工具按钮计数徽章（问题数在工具箱面板的功能按钮上，不在工具 fab 上）。
 *  lint 有 error→红、否则黄；修复类工具 = 待修复处数（中性）；0 隐藏。 */
function setToolBadge(modal, tool, items) {
  const b = modal.querySelector(`.tool-badge[data-badge="${tool}"]`);
  if (!b) return;
  const n = items.length;
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
  if (tool === 'lint') {
    const errs = items.filter((i) => i.severity === 'error').length;
    b.className = `tool-badge${errs ? ' err' : ' warn'}`;
  } else {
    b.className = 'tool-badge';
  }
}
/** 打开工具箱面板时并行预扫全部工具的计数（不阻塞当前工具列表）。 */
async function refreshToolBadges(ctx, modal) {
  const tools = ['lint', 'date', 'onboard', 'brackets', 'symbols', 'drift', 'images', 'regex', 'dup'];
  await Promise.all(tools.map(async (tk) => {
    try {
      const r = await api(`/api/w/${enc(ctx.worldId)}/tools/scan?tool=${tk}`);
      setToolBadge(modal, tk, r.items || []);
    } catch { /* 某工具扫描失败不阻塞其它徽章 */ }
  }));
}
function renderTools(ctx) {
  const modal = document.getElementById('tools-host');
  if (!modal) return;
  modal.innerHTML = `
      <div class="tools-layout">
        <nav class="tools-nav">
          ${['lint', 'structure', 'date', 'onboard', 'brackets', 'symbols', 'drift', 'images', 'regex', 'dup'].map((tk, i) => `
          <button class="filter-button${i === 0 ? ' is-active' : ''}" data-tool="${tk}"><span>${lt(tk === 'lint' ? 'lintTitle' : ({ structure: 'toolStructure', date: 'toolDate', onboard: 'toolOnboard', brackets: 'toolBrackets', symbols: 'toolSymbols', drift: 'toolDrift', images: 'toolImages', regex: 'toolRegex', dup: 'toolDup' })[tk])}</span><span class="tool-badge" data-badge="${tk}" hidden></span></button>`).join('')}
        </nav>
        <div class="tools-main">
          <div class="tools-list" id="tools-list"><div class="loading">${lt('toolScanning')}</div></div>
          <div class="tools-foot">
            ${checkHTML(true, 'ALL', 'id="tools-all-row"')}
            <span class="tools-count" id="tools-count"></span>
            <button class="button-primary" id="tools-apply" disabled>${lt('toolApply')}</button>
          </div>
        </div>
      </div>`;
  attachScrollIndicators(modal);

  const list = modal.querySelector('#tools-list');
  const count = modal.querySelector('#tools-count');
  const applyBtn = modal.querySelector('#tools-apply');
  let currentTool = 'date';
  let items = [];

  function esc2(s2) { return esc(s2); }

  async function runScan(tool) {
    currentTool = tool;
    list.innerHTML = `<div class="loading">${lt('toolScanning')}</div>`;
    applyBtn.disabled = true;
    try {
      const params = tool === 'regex' && ctx.regexQ ? `&q=${enc(ctx.regexQ)}&r=${enc(ctx.regexR || '')}` : '';
      const r = await api(`/api/w/${enc(ctx.worldId)}/tools/scan?tool=${tool}${params}`);
      items = r.items.map((x) => ({ ...x, checked: true }));
      setToolBadge(modal, tool, items);        // 计数徽章跟随扫描结果
    } catch (e) { items = []; showToast(String(e.message || e), 'error'); }
    paint();
  }

  function paint() {
    const isLint = currentTool === 'lint';
    applyBtn.style.display = isLint ? 'none' : '';
    const allRow0 = modal.querySelector('#tools-all-row');
    if (allRow0) allRow0.style.display = isLint ? 'none' : '';
    if (isLint) {
      count.textContent = `${items.length}`;
      list.innerHTML = items.map((it) => `
        <div class="alert-row lint-${it.severity}" data-path="${esc(it.path)}" title="${lt('lintJump')}">
          <span class="lint-msg">${esc(it.message)}</span>
          <span class="lint-loc">${esc(it.path)}${it.line ? ':' + it.line : ''}</span>
        </div>`).join('');
      list.querySelectorAll('.alert-row[data-path]').forEach((row) => row.addEventListener('click', () => {
        const p2 = row.dataset.path;
        if (!p2) return;
        if (p2 === ctx.currentPath) return;
        navigate(`#/w/${enc(ctx.worldId)}/${enc(p2)}`);
      }));
      return;
    }
    if (!items.length) {
      list.innerHTML = `<div class="empty-state">${lt('toolNoIssues')}</div>`;
      count.textContent = '';
      applyBtn.disabled = true;
      return;
    }
    const fixRows = items.filter((x) => !x.manual);
    const manualRows = items.filter((x) => x.manual);
    list.innerHTML = [
      ...manualRows.map((it) => `<div class="alert-row lint-info"><span class="lint-msg">${esc2(it.before)}</span><span class="lint-loc">${esc2(String(it.path).slice(0, 60))}</span></div>`),
      ...fixRows.map((it, i) => it.kind === 'move' ? `
      <div class="diff-row diff-move">
        ${checkHTML(it.checked, '', `data-i="${i}"`)}
        <span class="diff-path diff-move-tag">${state.lang === 'zh-CN' ? '移动' : 'move'}</span>
        <span class="diff-before">${esc2(it.before)}</span>
        <span class="diff-arrow">→</span>
        <span class="diff-after">${esc2(it.after)}</span>
      </div>` : `
      <div class="diff-row">
        ${checkHTML(it.checked, '', `data-i="${i}"`)}
        <span class="diff-path" title="${esc2(it.src || it.path)}">${esc2(it.path)}:${it.line}</span>
        <span class="diff-before">${esc2(it.before)}</span>
        <span class="diff-arrow">→</span>
        <span class="diff-after">${esc2(it.after === '' ? '（删除此行）' : it.after)}</span>
      </div>`),
    ].join('');
    bindChecks(list);
    list.querySelectorAll('.check-row[data-i]').forEach((row) => row.addEventListener('click', () => {
      fixRows[+row.dataset.i].checked = row.classList.contains('on');
      refreshCount();
    }));
    // 点击行（勾选框以外）→ 打开条目，并把错误处用批注框标出
    list.querySelectorAll('.diff-row').forEach((row, i) => row.addEventListener('click', (e) => {
      if (e.target.closest('.check-row')) return;
      const it = fixRows[i];
      if (!it?.path || it.kind === 'move') return;   // 移动行不跳转
      openWithAnnotation(ctx, it.path, `${it.before || ''}`);
    }));
    refreshCount();
  }
  function refreshCount() {
    const fixRows = items.filter((x) => !x.manual);
    const n = fixRows.filter((x) => x.checked).length;
    count.textContent = `${n} / ${fixRows.length}`;
    applyBtn.disabled = n === 0;
  }

  modal.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', async () => {
    modal.querySelectorAll('[data-tool]').forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    if (b.dataset.tool === 'regex') {
      const q = await askText(lt('toolRegexFind'), ctx.regexQ || '');
      if (q === null) return;
      const r2 = await askText(lt('toolRegexRepl'), ctx.regexR || '');
      if (r2 === null) return;
      ctx.regexQ = q; ctx.regexR = r2;
    }
    runScan(b.dataset.tool);
  }));
  const allRow = modal.querySelector('#tools-all-row');
  bindChecks(modal);
  allRow.addEventListener('click', () => {
    const on = allRow.classList.contains('on');
    items.forEach((x) => { if (!x.manual) x.checked = on; });
    paint();
    const row = modal.querySelector('#tools-all-row');
    row.classList.toggle('on', on);
  });
  applyBtn.addEventListener('click', async () => {
    const chosen = items.filter((x) => x.checked && !x.manual);
    if (!chosen.length) return;
    applyBtn.disabled = true;
    try {
      const r = await api(`/api/w/${enc(ctx.worldId)}/tools/apply`, {
        method: 'POST', body: { tool: currentTool, items: chosen },
      });
      worldDataCache.delete(ctx.worldId);
      refreshGitStatus(ctx);
      await refreshTimeline(ctx);   // 工具改动（含日期归一等）即刻上轴
          showToast(`${lt('toolApplied')} ${r.changed} ${lt('toolPlaces')} · backup: ${r.backup}`, 'success');
      runScan(currentTool);
      // 刷新当前阅读内容（若被修改）——原地重载，不动面板
      if (chosen.some((x) => x.path === ctx.currentPath)) {
        await openEntry(ctx, ctx.currentPath, ctx.chrono);
      }
    } catch (e) {
      showToast(String(e.message), 'error');
      applyBtn.disabled = false;
    }
  });

  runScan('lint');
  refreshToolBadges(ctx, modal);               // 打开面板即并行预扫全部工具的计数徽章
}
