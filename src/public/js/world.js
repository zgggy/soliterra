// 世界内工作台（功能设计 §2/§3/§4/§7/§8/§10/§11）
// 布局：时间轴（顶部通栏）+ 主区 push（目录/关系图）+ 四角：
//   左上世界卡（peek 左）· 左下设置面板（peek 左）· 左下角书架（cover-first）· 右侧稍后阅读区（peek 右）· 右下操作栏。

import { api, t, state, navigate, bindCoverFallbacks } from './app.js';
import { showLinkCard, hideCard, leaveAnchor } from './linkcard.js';
import { attachTilt } from './home.js';
import { download, subtreePaths, mdToTxt, buildEpub } from './exporter.js';
import { computeLayout, flagBaseW, LAYOUT, YEAR } from './timeline-layout.js';   // 第 75/76 轮：布局引擎（规则与常量单点真相）

// 世界数据缓存（tree/timeline 变化少）：导航重渲染几乎同步 → 消除闪屏（YEAR 已由引擎导出，单一来源）
const worldDataCache = new Map();   // worldId -> { tree, timeline, ts }
const DEV = new URLSearchParams(location.search).has('dev');   // ?dev=1 → 每帧更新 window.__tlPerf（第 77 轮探针）
const tocOpenDirs = new Set();    // 目录手动展开的目录（跨重渲染记忆，防闪回）
let activeWorld = null;           // { id, update(path) }：同世界导航走原地更新（不整页重载）
let lastTimelineView = null;     // { world, lo, hi } 当前时间轴视野（重渲染的起点：从现在的值出发）
let axisKeyHandler = null;      // 时间轴键盘 handler 单例（重绑即解绑，防多实例叠加）
let worldKeyHandler = null;     // 世界快捷键 handler 单例（同上）
// 常驻制：面板不再依赖 proximity（世界面板/书架/稍后阅读常驻；操作栏收为一个按钮）

function parseOrd(text) {
  if (!text) return null;
  const m = String(text).match(/^(-?)(\d{1,4})\.(\d{1,2}|\*)\.(\d{1,2}|\*)$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const y = parseInt(m[2], 10) * sign;
  const mo = m[3] === '*' ? 6 : parseInt(m[3], 10);
  const d = m[4] === '*' ? 15 : parseInt(m[4], 10);
  return y * YEAR + (mo - 1) * 30.44 + (d - 1);
}
function enc(s) { return encodeURIComponent(s); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 内置短语（未入 locale 的少量新文案，保持双语）
const L = {
  world: { 'zh-CN': '世界', en: 'WORLD' },
  settings: { 'zh-CN': '设置', en: 'SET' },
  later: { 'zh-CN': '稍后阅读', en: 'READ LATER' },
  theme: { 'zh-CN': '日/夜', en: 'Theme' },
  font: { 'zh-CN': '字体', en: 'Font' },
  size: { 'zh-CN': '字号', en: 'Size' },
  leading: { 'zh-CN': '行高', en: 'Leading' },
  measure: { 'zh-CN': '列宽', en: 'Width' },
  back: { 'zh-CN': '返回世界列表', en: 'Back to Worlds' },
  dashMap: { 'zh-CN': '地图', en: 'Map' },
  commit: { 'zh-CN': '退出并提交', en: 'Exit & Commit' },
  showRel: { 'zh-CN': '展示关系', en: 'Relations' },
  relBack: { 'zh-CN': '含反链', en: 'Backlinks' },
  relFull: { 'zh-CN': '展开全图', en: 'Full graph' },
  relEmpty: { 'zh-CN': '本文档尚无双链', en: 'No links yet' },
  moreSettings: { 'zh-CN': '更多设置', en: 'More settings' },
  tools: { 'zh-CN': '工具', en: 'Tools' },
  shelfAll: { 'zh-CN': '全部书籍', en: 'All books' },
  shelfBooks: { 'zh-CN': '本', en: 'books' },
  uncommitted: { 'zh-CN': '未提交', en: 'uncommitted' },
  commitNow: { 'zh-CN': '提交', en: 'Commit' },
  commitMsg: { 'zh-CN': '提交信息', en: 'Commit message' },
  booksN: { 'zh-CN': '书籍', en: 'Books' },
  entriesN: { 'zh-CN': '条目', en: 'Entries' },
  toolsTitle: { 'zh-CN': '工具箱', en: 'Toolbox' },
  lintTitle: { 'zh-CN': '一致性校验', en: 'Consistency lint' },
  export: { 'zh-CN': '导出', en: 'Export' },
  dashboard: { 'zh-CN': '仪表盘', en: 'Dashboard' },
  dashJump: { 'zh-CN': '时间轴取景到', en: 'Jump timeline to' },
  dashLater: { 'zh-CN': '加入稍后阅读', en: 'Read later' },
  dashTools: { 'zh-CN': '打开工具箱', en: 'Open toolbox' },
  exDocMd: { 'zh-CN': '文档 md', en: 'Doc md' },
  exDocTxt: { 'zh-CN': '文档 txt', en: 'Doc txt' },
  exBookMd: { 'zh-CN': '本书 md', en: 'Book md' },
  exBookEpub: { 'zh-CN': '本书 EPUB', en: 'Book EPUB' },
  exBookPdf: { 'zh-CN': '本书 PDF', en: 'Book PDF' },
  gitHistory: { 'zh-CN': '历史', en: 'History' },
  rollback: { 'zh-CN': '回滚为此版本', en: 'Rollback' },
  rollbackSure: { 'zh-CN': '确认回滚？（将产生一个新提交）', en: 'Rollback? (creates a new commit)' },
  rollbackOk: { 'zh-CN': '确认', en: 'Yes' },
  rollbackCancel: { 'zh-CN': '取消', en: 'No' },
  toolDrift: { 'zh-CN': '拼写漂移（近似双链）', en: 'Spelling drift (near links)' },
  toolImages: { 'zh-CN': '图片路径规范化', en: 'Normalize image paths' },
  toolRegex: { 'zh-CN': '全库正则替换', en: 'Regex replace (all)' },
  toolDup: { 'zh-CN': '重名判断与修复', en: 'Duplicate titles' },
  toolRegexFind: { 'zh-CN': '正则（查找）', en: 'Pattern' },
  toolRegexRepl: { 'zh-CN': '替换为（可含 $1…）', en: 'Replace with ($1…)' },
  lintJump: { 'zh-CN': '打开条目', en: 'Open entry' },
  toolDate: { 'zh-CN': '日期时间规范化', en: 'Normalize dates & times' },
  toolBrackets: { 'zh-CN': '【【】】 → [[ ]]', en: '【【】】 → [[ ]]' },
  toolScanning: { 'zh-CN': '扫描中…', en: 'Scanning…' },
  toolNoIssues: { 'zh-CN': '没有需要修复的内容', en: 'Nothing to fix' },
  toolApply: { 'zh-CN': '应用选中', en: 'Apply selected' },
  toolApplied: { 'zh-CN': '已修复', en: 'Fixed' },
  toolPlaces: { 'zh-CN': '处', en: 'places' },
  language: { 'zh-CN': '语言 Language', en: 'Language' },
  about: { 'zh-CN': '关于', en: 'About' },
};
function lt(key) { return L[key][state.lang] || L[key].en; }

// 细线图标（stroke 1.3 / currentColor / 无填充）——按钮线条图标铁律
const ICON = {
  plus: '<svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11"/></svg>',
  grid: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4.6" height="4.6"/><rect x="8.9" y="2.5" width="4.6" height="4.6"/><rect x="2.5" y="8.9" width="4.6" height="4.6"/><rect x="8.9" y="8.9" width="4.6" height="4.6"/></svg>',
  menu: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
  pencil: '<svg viewBox="0 0 16 16"><path d="M10.6 2.6l2.8 2.8-8 8-3.4 1 .9-3.3 7.7-8.5zM9.4 3.9l2.8 2.8"/></svg>',
  save: '<svg viewBox="0 0 16 16"><path d="M8 2v6.6M5.4 6.2L8 8.8l2.6-2.6M3 12.6h10"/></svg>',
  rel: '<svg viewBox="0 0 16 16"><rect x="1.8" y="6.2" width="4.2" height="4.2"/><rect x="10" y="1.8" width="4.2" height="4.2"/><rect x="10" y="10" width="4.2" height="4.2"/><path d="M6 7.6l4-3.3M6 8.6l4 3.2"/></svg>',
  tools: '<svg viewBox="0 0 16 16"><rect x="2" y="6.6" width="12" height="6.9"/><path d="M6 6.6V3.9h4v2.7"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  chevronL: '<svg viewBox="0 0 16 16"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>',
  chevronR: '<svg viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
};

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
  ctx.scopeTop = ctx.currentPath ? ctx.currentPath.split('/')[0] : null;   // 时间轴范围当前所属（与 openEntry 的切书判断一致）
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
  const savedPanel = sessionStorage.getItem('soliterra.panel');
  const initial = savedPanel === null ? 'toc' : savedPanel;
  if (initial && entryPath) { setPanel(ctx, initial); ctx.panelPainted = true; }

  // ---------- 阅读 ----------
  if (entryPath) {
    await openEntry(ctx, entryPath, chrono);
  } else {
    // 默认：打开根书（世界同名书）的首页（书名.md），并展开目录
    const rootBook = ctx.tree.children.find((c) => c.name === worldId) || ctx.tree.children[0];
    const first = rootBook ? firstEntryOf(rootBook) : null;
    if (first) {
      sessionStorage.setItem('soliterra.panel', 'toc');
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

/** 离开世界（回首页）→ 注销原地更新实例。 */
export function leaveWorld() { activeWorld = null; }

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

/** 新建书籍（第 79 轮抽出共用）：书名 → `书名.md` + `书名/` 同名目录（pair）→ 刷新树/状态/书籍面板 → 打开新书。 */
async function addBook(ctx) {
  const name = await askText(state.lang === 'zh-CN' ? '新书名' : 'Book name');
  if (!name || !name.trim()) return;
  try {
    const r = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: '', name: name.trim(), pair: true } });
    await refreshTree(ctx);
    refreshGitStatus(ctx);
    showToast(state.lang === 'zh-CN' ? `已建书：${name}` : `Book created: ${name}`, 'success');
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
        <button class="panel-head-btn" id="toc-add-book" title="${state.lang === 'zh-CN' ? '加一本书' : 'New book'}">＋</button>
      </div>
      <div class="panel-scroll"><div class="toc-body" id="toc-body"></div></div>`;
    renderToc(ctx);
    bindPanelResize(ctx, 'left', '--toc-w', 'soliterra.tocW');
    document.getElementById('toc-add-book')?.addEventListener('click', () => addBook(ctx));
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
  view.style.setProperty('--reading-font',
    s.font === 'sans' ? 'var(--font-ui)' : s.font === 'mono' ? 'var(--font-mono)' : 'var(--font-serif)');
  view.style.setProperty('--reading-size', (s.size || 18) / 16 + 'rem');
  view.style.setProperty('--reading-leading', s.leading || (state.lang === 'en' ? '1.65' : '1.8'));
  view.style.setProperty('--reading-measure', (s.measure || 42) + 'rem');
}

// 设置条目（并入 + 世界面板，自上而下：主题/字体/字号/行高/列宽/语言；不再有独立设置面板）
function settingsRowsHTML() {
  const segs = [
    ['theme', lt('theme'), [['light', '☀'], ['dark', '☾'], ['auto', '◐']]],
    ['font', lt('font'), [['serif', 'Aa'], ['sans', 'Aa'], ['mono', 'Aa']]],
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
    const cur = ctx.settings[key] ?? seg.querySelector('button')?.dataset.val;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.val === String(cur));
      b.addEventListener('click', async () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
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
  const rootNode = ctx.tree.children.find((c) => c.name === ctx.worldId) || ctx.tree.children[0];
  const cover = rootNode?.cover;
  const bookCount = ctx.tree.children.filter((c) => c.md || c.children.length).length;
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
    <div class="set-row"><span class="eyebrow">${lt('dashboard')}</span>
      <button class="button-ghost wp-dash" id="wp-dash">→</button></div>
    <div class="set-row wp-export-row"><span class="eyebrow">${lt('export')}</span>
      <span class="export-btns">
        <button class="button-ghost" id="ex-doc-md">${lt('exDocMd')}</button>
        <button class="button-ghost" id="ex-doc-txt">${lt('exDocTxt')}</button>
        <button class="button-ghost" id="ex-book-md">${lt('exBookMd')}</button>
        <button class="button-ghost" id="ex-book-epub">${lt('exBookEpub')}</button>
        <button class="button-ghost" id="ex-book-pdf">${lt('exBookPdf')}</button>
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
  const top = ctx.tree.children.find((c) => (ctx.currentPath || '').startsWith(c.name + '/')) || ctx.tree.children.find((c) => c.name === ctx.worldId) || ctx.tree.children[0];
  host.querySelector('#ex-doc-md').addEventListener('click', () => exportDoc(ctx, 'md'));
  host.querySelector('#ex-doc-txt').addEventListener('click', () => exportDoc(ctx, 'txt'));
  host.querySelector('#ex-book-md').addEventListener('click', () => exportBook(ctx, 'md', top));
  host.querySelector('#ex-book-epub').addEventListener('click', () => exportBook(ctx, 'epub', top));
  host.querySelector('#ex-book-pdf').addEventListener('click', () => exportBook(ctx, 'pdf', top));
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
    if (fmt === 'md') {
      const parts = [];
      for (const p2 of paths) {
        const { text } = await api(`/api/w/${enc(ctx.worldId)}/raw?path=${enc(p2)}`);
        parts.push(text);
      }
      download(`${name}.md`, new Blob([parts.join('\n\n---\n\n')], { type: 'text/markdown;charset=utf-8' }));
      showToast(`${state.lang === 'zh-CN' ? '已导出' : 'Exported'} · ${paths.length} §`, 'success');
      return;
    }
    const chapters = [];
    for (const p2 of paths) {
      const e = await api(`/api/w/${enc(ctx.worldId)}/entry?path=${enc(p2)}`);
      chapters.push({ title: e.title || p2, html: `<div class="meta">${e.rangeHTML || ''}</div>${e.html}` });
    }
    if (fmt === 'epub') {
      download(`${name}.epub`, buildEpub({ title: name, chapters }));
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
  const loadLog = async () => {
    const { commits } = await api(`/api/w/${enc(ctx.worldId)}/git/log`);
    list.innerHTML = commits.length ? commits.map((c) => `
      <button class="git-commit" data-rev="${esc(c.hash)}">
        <span class="git-hash">${esc(c.hash)}</span>
        <span class="git-subj">${esc(c.subject)}</span>
        <span class="git-when">${esc(c.when)}</span>
      </button>`).join('') : `<div class="empty-state">${state.lang === 'zh-CN' ? '暂无提交' : 'No commits'}</div>`;
    list.querySelectorAll('.git-commit').forEach((b) => b.addEventListener('click', () => {
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

/** 极简纸面（与 askDialog 同族；openPaperDialog 已被面板方案取代，此处轻量实现）。 */
function openPaperDialog2(title) {
  const modal = document.createElement('div');
  modal.className = 'reader-modal active';
  modal.innerHTML = `
    <div class="modal-dialog git-dialog">
      <div class="modal-header"><span class="eyebrow">${esc(title)}</span><button class="modal-close" data-close>×</button></div>
      <div class="dialog-body"></div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  return { modal, close, body: modal.querySelector('.dialog-body') };
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
async function refreshGitStatus(ctx) {
  const st = await api(`/api/w/${enc(ctx.worldId)}/git/status`).catch(() => ({ dirty: 0 }));
  ctx.gitDirty = st.dirty;
  const wd = document.getElementById('wp-dirty');
  const wc = document.getElementById('wp-commit');
  if (wd) {
    wd.className = `wp-dirty${st.dirty > 0 ? ' warn' : ''}`;   // 有=黄 无=灰
    wd.textContent = st.dirty > 0 ? `${st.dirty} ${lt('uncommitted')}` : (state.lang === 'zh-CN' ? '无未提交条目' : 'clean');
  }
  if (wc) wc.hidden = st.dirty === 0;
}

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

// ============ 全部书籍面板（左 push：竖排网格滚动 · 双列起 · hover 倾斜 · 宽可变列数） ============
function renderBooksPanel(ctx) {
  const grid = document.getElementById('books-grid');
  if (!grid) return;
  const count = document.getElementById('books-count');
  const filter = document.getElementById('books-filter');
  const books = ctx.tree.children.filter((c) => c.md || c.children.length);
  // 分类 filter（§8.3）：顶层书的 &t 标签去重成 chip 行（旧弹层的分类行迁移）
  const cats = [];
  for (const b of books) for (const tg of (b.tags || [])) if (!cats.includes(tg)) cats.push(tg);
  ctx.booksCat = ctx.booksCat || '全部';
  if (ctx.booksCat !== '全部' && !cats.includes(ctx.booksCat)) ctx.booksCat = '全部';

  function paintGrid() {
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
        <div class="book-card-tags eyebrow">${esc((b.tags || []).slice(0, 2).join(' · ')) || '—'}</div>
      </button>`).join('');
    grid.querySelectorAll('.book-card').forEach((card) => {
      attachTilt(card);
      const b = books.find((x) => x.name === card.dataset.name);
      card.addEventListener('click', () => {
        const first = b ? firstEntryOf(b) : null;
        if (!first) return;
        sessionStorage.setItem('soliterra.panel', 'toc');
        if (first === ctx.currentPath) setPanel(ctx, 'toc');
        else navigate(`#/w/${enc(ctx.worldId)}/${enc(first)}`);
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
  }
  if (filter) {
    filter.hidden = cats.length === 0;
    filter.innerHTML = ['全部', ...cats].map((c) => `<button class="bf-chip${c === ctx.booksCat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
    filter.querySelectorAll('.bf-chip').forEach((b) => b.addEventListener('click', () => {
      ctx.booksCat = b.dataset.cat;
      filter.querySelectorAll('.bf-chip').forEach((x2) => x2.classList.toggle('on', x2 === b));
      paintGrid();
    }));
  }
  paintGrid();
}

function firstEntryOf(node) {
  if (node.md) return node.md;
  for (const c of node.children) { const r = firstEntryOf(c); if (r) return r; }
  return null;
}

// ============ 稍后阅读（底部中央卡片集：rest = 扇形聚拢；hover = 横排展开；单卡 hover 上升） ============
const FAN = { w: 108, h: 140, show: 70, rise: 28, gap: 8, restPitch: 26, minPitch: 22 };

function renderReadlater(ctx) {
  const fan = document.getElementById('readlater-fan');
  const set = document.getElementById('rlf-set');
  if (!fan || !set) return;
  const items = ctx.readlater || [];
  fan.hidden = items.length === 0;
  if (!set.dataset.bound) {
    set.dataset.bound = '1';
    set.addEventListener('mouseenter', () => { set.classList.add('open'); layoutFan(ctx); });
    set.addEventListener('mouseleave', () => { set.classList.remove('open'); ctx.fanHover = null; layoutFan(ctx); });
  }
  set.innerHTML = '';
  items.forEach((item, i) => {
    const card = document.createElement('button');
    card.className = `rlf-card${item.path === ctx.currentPath ? ' open' : ''}`;
    card.dataset.path = item.path;
    if (ctx.rlfPulse === item.path) {                 // 新加入 → 160ms 脉冲（§19 登记表）
      card.classList.add('pulse');
      card.addEventListener('animationend', () => card.classList.remove('pulse'), { once: true });
    }
    card.innerHTML = `
      <span class="rlf-eyebrow">${esc(item.kind || 'entry')}</span>
      <span class="rlf-title">${esc(item.title)}</span>
      <span class="rlf-close" role="button" title="${state.lang === 'zh-CN' ? '移出稍后阅读' : 'Remove from read later'}">${ICON.close}</span>`;
    card.addEventListener('mouseenter', () => { ctx.fanHover = i; layoutFan(ctx); });
    card.addEventListener('mouseleave', () => { if (ctx.fanHover === i) { ctx.fanHover = null; layoutFan(ctx); } });
    card.addEventListener('click', () => navigate(`#/w/${enc(ctx.worldId)}/${enc(item.path)}`));
    card.querySelector('.rlf-close').addEventListener('click', async (e) => {
      e.stopPropagation();
      ctx.readlater = await api(`/api/w/${enc(ctx.worldId)}/readlater`, { method: 'POST', body: { action: 'remove', path: item.path } });
      ctx.fanHover = null;
      renderReadlater(ctx);
    });
    set.appendChild(card);
  });
  ctx.rlfPulse = null;              // 脉冲只作用于本次新加入的那张卡
  layoutFan(ctx);
}

/** 卡片集布局：rest=扇形（旋转 + 聚拢）；open=横排（尽量不重叠；不侵入左右按钮群 40px 内）。 */
function layoutFan(ctx) {
  const set = document.getElementById('rlf-set');
  if (!set) return;
  const cards = [...set.querySelectorAll('.rlf-card')];
  const n = cards.length;
  if (!n) { set.style.width = '0px'; return; }
  const open = set.classList.contains('open');
  const edge = 8 + 3 * 40 + 2 * 8;                       // 左右 fab 群宽（到边 8 + 三钮 + 两间隙）
  const maxW = Math.max(240, innerWidth - 2 * edge - 80); // 与两侧按钮群各留 ≥40px
  let pitch;
  let angles;
  if (open) {
    const need = n * FAN.w + (n - 1) * FAN.gap;
    pitch = need <= maxW ? FAN.w + FAN.gap : Math.max(FAN.minPitch, (maxW - FAN.w) / (n - 1));
    angles = new Array(n).fill(0);
  } else {
    pitch = FAN.restPitch;
    const spread = Math.min(9, 26 / Math.max(n - 1, 1));
    angles = cards.map((_, i) => (i - (n - 1) / 2) * spread);
  }
  pitch = Math.min(pitch, Math.max(12, (maxW - FAN.w) / Math.max(n - 1, 1)));   // 卡片过多时压缩间距，总宽永不越界
  set.style.width = Math.min((n - 1) * pitch + FAN.w, maxW) + 'px';
  cards.forEach((card, i) => {
    const x = (i - (n - 1) / 2) * pitch;
    const hovered = open && ctx.fanHover === i;
    const y = hovered ? -FAN.rise : 0;
    card.style.transform = `translateX(${x}px) translateY(${y}px) rotate(${angles[i]}deg)`;
    card.style.zIndex = String(hovered ? 40 : 10 + i);
    card.classList.toggle('lift', hovered);
  });
}

async function addReadlater(ctx, path) {
  const title = path.split('/').pop().replace(/\.md$/i, '');
  ctx.readlater = await api(`/api/w/${enc(ctx.worldId)}/readlater`, {
    method: 'POST', body: { action: 'add', item: { path, title } },
  });
  ctx.rlfPulse = path;
  renderReadlater(ctx);
  showToast(state.lang === 'zh-CN' ? '已加入稍后阅读' : 'Added to read later', 'success');
}


// ============ 时间轴（功能设计 §3） ============
function initTimeline(ctx, wrap, canvas, ticks) {
  const buildItems = () => ctx.timeline.map((r) => {
    let tg = [];
    try { tg = r.tags_json ? JSON.parse(r.tags_json) : []; } catch {}
    // 创世条目（&f 创世 或 &t 含「创世」）：不按 &s 上轴、不计入时间轴总范围；显示在「最早时间之前」
    const genesis = r.flag === '创世' || (Array.isArray(tg) ? tg : String(tg || '').split(/\s+/)).includes('创世');
    return { ...r, s: parseOrd(r.start), e: parseOrd(r.end), era: r.era || null, genesis };
  }).filter((r) => r.s != null || r.genesis);   // 创世无 &s 也保留（创世排不依赖时刻）
  let allItems = buildItems();
  // 时间轴范围 = 本书（§A 二次定型）：顶层散文件文档 → 全库；换书由 setScope 重建
  let items = [];
  const view = { lo: 0, hi: 1 };
  const full = { lo: 0, hi: 1 };
  function rescope(keepView = false) {
    const top = (ctx.currentPath || '').split('/')[0].replace(/\.md$/i, '');
    const node = ctx.tree.children.find((c) => c.name === top);
    const inBook = !!(node && node.children && node.children.length);
    items = inBook
      ? (() => { const set = new Set(flattenTree(node).map((e) => e.path)); return allItems.filter((i) => set.has(i.path)); })()
      : allItems;
    // 范围**只由非创世条目定义**（2026-10-06：创世永不参与，任何书/任何视图下皆然）——
    // 本书没有真实时刻（全是创世/无时刻）→ 退回**全库真实范围**，绝不拿创世时刻当范围。
    const timed = items.filter((i) => !i.genesis && i.s != null);
    const base = timed.length ? timed : allItems.filter((i) => !i.genesis && i.s != null);
    if (base.length) {
      const lo = Math.min(...base.map((i) => i.s));
      const hi = Math.max(...base.map((i) => Math.max(i.s, i.e ?? i.s)));   // 末覆盖最晚结束（卡片按开始时间定位，轴尾须容下所有绘制）
      const pad = (hi - lo) * LAYOUT.RANGE_PAD || YEAR;
      full.lo = lo - pad; full.hi = hi + pad;
      if (!keepView) { view.lo = lo - pad; view.hi = hi + pad; }   // 数据刷新（元数据保存）→ 保持当前视野，只更新范围
    }
    earliestOrd = base.length ? Math.min(...base.map((i) => i.s)) : null;
    latestOrd = base.length ? Math.max(...base.map((i) => Math.max(i.s, i.e ?? i.s))) : null;
    // 创世**虚拟时刻**（第 73 轮）：范围起点前 1%（range=0 退 1 年）——由范围派生、**不反馈进范围**（第 62 轮
    // 「创世不计入总范围」不变）；创世的定位/取景/出界带回全部走它 → 缩放、拖动、合并、点击逻辑统一。
    genesisOrd = earliestOrd != null ? earliestOrd - (((latestOrd - earliestOrd) * LAYOUT.GENESIS_RATIO) || YEAR) : null;
    return top;
  }
  let earliestOrd = null, latestOrd = null, genesisOrd = null;
  const axisLine = document.createElement('div');   // 轴线段：只显示范围（最早→最晚时间）内，范围外（含创世排区）不画
  axisLine.className = 'chrono-axis';
  wrap.appendChild(axisLine);
  // 出界指示（§E.4）：bar 左右缘「◀ N / N ▶」——完全在视口外的卡片数；点击平滑取景把最近一批带回
  const hintL = document.createElement('button');
  hintL.className = 'edge-hint left'; hintL.hidden = true;
  hintL.innerHTML = `${ICON.chevronL}<span class="hint-n"></span>`;
  hintL.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  hintL.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (hintL.__ord == null) return;
    const span = view.hi - view.lo;
    animateTo(hintL.__ord - span * 0.25, hintL.__ord + span * 0.75, 300);   // 最近出界卡落到 1/4 屏
  });
  wrap.appendChild(hintL);
  const hintR = document.createElement('button');
  hintR.className = 'edge-hint right'; hintR.hidden = true;
  hintR.innerHTML = `<span class="hint-n"></span>${ICON.chevronR}`;
  hintR.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  hintR.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (hintR.__ord == null) return;
    const span = view.hi - view.lo;
    animateTo(hintR.__ord - span * 0.75, hintR.__ord + span * 0.25, 300);   // 最近出界卡落到 3/4 屏
  });
  wrap.appendChild(hintR);
  // 创世向左渐隐箭头（§E.4）：跟创世组左缘，z 压在卡下（贴边时自然从卡后探出）
  const genesisTail = document.createElement('div');
  genesisTail.className = 'genesis-tail'; genesisTail.hidden = true;
  genesisTail.innerHTML = `${ICON.chevronL}<span class="gt-line"></span>`;
  wrap.appendChild(genesisTail);
  const scopeBook = rescope();
  // 从**当前视图**出发（不跳回默认初值）：同世界同书重渲染沿用上次视野。
  // 打开条目**不加取景**（2026-10-06：删除条目点击的自动缩放）；取景补间仅剩「强调」拖拽与 ⌘K/时代带。
  if (lastTimelineView && lastTimelineView.world === ctx.worldId && lastTimelineView.book === scopeBook) {
    view.lo = lastTimelineView.lo; view.hi = lastTimelineView.hi;
  }
  let anim = null;                // rAF 补间句柄
  const markers = document.createElement('div');
  markers.className = 'chrono-markers';
  wrap.appendChild(markers);
  const eras = document.createElement('div');   // 时代带（§3.2）：轴下 h10
  eras.className = 'chrono-eras';
  wrap.appendChild(eras);
  const flagEls = new Map();     // path -> 旗标元素（跨 layout 复用 → 位置/宽度随缩放平滑过渡）
  const spanEls = new Map();     // path -> 覆盖条元素
  const tickEls = new Map();     // ord -> 刻度元素（第 77 轮复用，替换逐帧 innerHTML 重建）
  const markerEls = new Map();   // ord -> 起止标记元素
  const eraEls = new Map();      // era 名 -> 时代带按钮（点击 handler 一次性绑定，数据存 el.__era）
  const topMemo = new Map();     // path -> 上一帧 top（创世尾箭头单帧滞后取样；第 75 轮起不再写回条目对象）
  let widthRetry = false;        // 实测宽尾随重排的一次性守卫（第 76 轮：新元素/簇成形首帧）

  // ---------- 高模式（§A 修正版）：高度 > 2/3 屏 → 本书全部（有时刻）条目上轴 ----------
  // 显示逻辑与普通模式完全一致（轴线/刻度/按时间定位/引线/分道堆叠都不变），只是面积变大、
  // 上轴的卡片从「&f ∪ 当前 ∪ 强调」扩为本书全部条目；无时刻条目不上轴（无 x 可放）。
  const worldViewEl = wrap.closest('.world-view') || wrap.parentElement;
  let tall = false;                                          // 由 layout() 按 --chrono-h 目标值判定（24px 滞回）
  let flagSetCache = { key: null, map: new Map() };

  /** 当前文档所属书的条目 path→tags（散文件文档 → 全库）；跨导航按 top 缓存。 */
  function bookFlagMap() {
    const top = (ctx.currentPath || '').split('/')[0].replace(/\.md$/i, '');
    if (flagSetCache.key === top) return flagSetCache.map;
    const node = ctx.tree.children.find((c) => c.name === top);
    const root = (node && node.children && node.children.length) ? node : ctx.tree;
    const map = new Map();
    const walk = (n) => { if (n.md) map.set(n.md, n.tags || []); for (const c of n.children) walk(c); };
    walk(root);
    flagSetCache = { key: top, map };
    return map;
  }

  /** 旗标/卡片元素工厂（跨 layout 复用；事件按 dataset.path 动态寻址）。 */
  function ensureFlagEl(path) {
    let flag = flagEls.get(path);
    if (flag) return flag;
    flag = document.createElement('button');
    flag.dataset.path = path;
    flag.dataset.fresh = '1';                // 新建 → 首次布局时淡入
    flagEls.set(path, flag);
    flag.addEventListener('click', () => {
      if (flag.__unpin) { flag.__unpin = false; return; }
      if (flag.__clusterSpan) {
        if (flag.__clusterOrd != null) focusOrd(flag.__clusterOrd, flag.__clusterSpan);   // 聚合簇（§E.3）：点击 = 取景该时刻（创世 = 虚拟时刻）
        return;
      }
      navigate(`#/w/${enc(ctx.worldId)}/${enc(path)}`);
    });
    const hot = () => {
      spanEls.get(path)?.classList.add('show');
      flag.classList.add('expand'); flag.style.zIndex = (flag.__zi = '90');
      const t = flag.__altTitle ? flag.querySelector('.flag-title') : null;
      if (t) t.textContent = flag.__altTitle;          // 簇：展开显示成员名单
    };
    const restore = () => {
      spanEls.get(path)?.classList.remove('show');
      flag.style.zIndex = (flag.__zi = flag.dataset.z || '10');   // 同步幂等缓存（第 77 轮）
      if (path !== ctx.currentPath) flag.classList.remove('expand');
      const t = flag.__baseTitle ? flag.querySelector('.flag-title') : null;
      if (t) t.textContent = flag.__baseTitle;
    };
    flag.addEventListener('mouseenter', hot);
    flag.addEventListener('mouseleave', restore);
    flag.addEventListener('focus', hot);          // 键盘 focus = hover 同款（§3.8）
    flag.addEventListener('blur', restore);
    canvas.appendChild(flag);
    return flag;
  }

  /** 卡片内容（对比 dataset 防重建）；pinned 时含 × 取消强调。 */
  function paintFlag(flag, { eyebrow, title, date, fuzzy, pinned }) {
    const key = `${eyebrow}|${title}|${date}|${pinned ? 1 : 0}`;
    flag.__paint = key;   // expando 镜像：layout 尾部校验用（避免写后再读 dataset 触发强制样式重算）
    if (flag.dataset.paint === key) return;
    flag.dataset.paint = key;
    flag.dataset.eyebrow = eyebrow;
    flag.dataset.title = title;
    flag.innerHTML = `
      <span class="flag-eyebrow">${esc(eyebrow)}</span>
      <span class="flag-title">${esc(title)}</span>
      <span class="flag-date">${fuzzy ? '≈' : ''}${esc(date)}</span>${pinned ? `<span class="flag-unpin" title="${state.lang === 'zh-CN' ? '取消强调' : 'Unpin'}">${ICON.close}</span>` : ''}`;
    flag.querySelector('.flag-unpin')?.addEventListener('click', (e) => {
      e.stopPropagation();
      flag.__unpin = true;
      ctx.pins.delete(flag.dataset.path);
      sessionStorage.setItem(`soliterra.pins.${ctx.worldId}`, JSON.stringify([...ctx.pins]));
      layout();
    });
  }

  /** 显示旗标的条目：带 &f ∪ 正在打开的 ∪ 强调 ∪（高模式）本书全部；无时刻条目不上轴。 */
  function displayFlagOf(it) {
    if (it.flag) return it.flag;
    if (it.path === ctx.currentPath) return state.lang === 'zh-CN' ? '当前' : 'NOW';
    if (ctx.pins.has(it.path)) return state.lang === 'zh-CN' ? '强调' : 'PIN';
    if (tall) {
      const tags = bookFlagMap().get(it.path);
      if (tags) return tags[0] || (state.lang === 'zh-CN' ? '条目' : 'ENTRY');
    }
    return '';
  }

  function layout() {
    const width = wrap.clientWidth;
    if (!width) return;
    const t0 = DEV ? performance.now() : 0;   // ?dev=1 探针：整帧（computeLayout + 应用 DOM）耗时
    // 打开卡实测尺寸：**应用前**取样（与本帧样式一致；旧管线亦在应用前读取）
    const oEl0 = flagEls.get(ctx.currentPath);
    const openSize = oEl0 ? { w: oEl0.offsetWidth, h: oEl0.offsetHeight } : null;
    const prevTops = Object.fromEntries(topMemo);   // 上一帧 top（创世尾箭头取样沿用单帧滞后；合并成员保留其上次单独显示的值）
    // 实测宽（第 76 轮）：缓存挂在元素上（__natW/__natPaint/__natCompact）——自然宽经"提上限实测"取得，
    // 引擎取 min(自然宽, 基准宽) = 渲染宽，碰撞箱 ≡ 渲染箱；稳态零 DOM 读取
    const measuredW = {};
    for (const [p, el] of flagEls) if (el.__natW > 0) measuredW[p] = el.__natW;
    // 高模式判定（§A）：高度目标 > 2/3 屏进入（退出阈 2/3 − 24px 滞回）；读 --chrono-h（拖动目标值，非过渡值）
    const hTarget = parseInt(getComputedStyle(worldViewEl).getPropertyValue('--chrono-h')) || 112;
    const t1 = window.innerHeight * 2 / 3;
    tall = tall ? hTarget > t1 - 24 : hTarget > t1;
    // ── 布局引擎（第 75 轮）：纯函数算出整帧（placements/spans/ticks/markers/eras/axis/hints/tail）——
    //    碰撞半箱、first-fit 分道、三类聚簇、创世虚拟时刻、O 卡三通道等规则全部收敛在 timeline-layout.js；
    //    本文件只负责「读输入 → computeLayout → 应用 DOM」+ 显示策略（displayFlagOf）与元素池。
    const pool = new Map(items.map((i) => [i.path, i]));
    for (const i of allItems) if (i.genesis) pool.set(i.path, i);   // 旗标池 = 本书 items ∪ 全世界创世（跨书恒显示）
    const flags = {};
    for (const it of pool.values()) { const e2 = displayFlagOf(it); if (e2) flags[it.path] = e2; }
    const pe0 = DEV ? performance.now() : 0;   // 探针相位：引擎起
    const frame = computeLayout({
      items, genesisAll: allItems, flags,
      view, full, width, chronoH: hTarget, lang: state.lang, currentPath: ctx.currentPath,
      genesisOrd, earliestOrd, latestOrd,
      openSize, prevTops, measuredW,
    });
    const pe1 = DEV ? performance.now() : 0;   // 引擎止
    applyFrame(frame);
    const pa1 = DEV ? performance.now() : 0;   // 应用止
    topMemo.clear();
    for (const p of frame.placements) if (!p.cluster) topMemo.set(p.path, p.top);
    // 实测宽收敛（第 76 轮）：缓存缺失 / 内容变化（paint 签名 + compact）→ 提 --flag-w 上限实测**自然宽**
    // （整批一次同步重排；transition 临时关掉防中间值）；实测与"本帧放置宽"有差异 → 调度**一次** rAF 重排
    // （自终止：重排用上新鲜缓存后 want == w）
    // 实测宽校验（第 76/77 轮）：**纯 expando 比较、零 DOM 读取**——读必须全部发生在 applyFrame 写之前；
    // 写后再读 dataset/style 会强制样式重算（300 卡世界实测 ~20ms/帧，本轮修掉的正是这一处）
    const stale = [];
    for (const p of frame.placements) {
      const el = flagEls.get(p.path);
      if (!el) continue;
      if (el.__natPaint !== el.__paint || el.__natCompact !== frame.compact) stale.push({ p, el });
    }
    if (stale.length) {
      const prevs = stale.map(({ el }) => [el.style.getPropertyValue('--flag-w'), el.style.transition]);
      for (const { el } of stale) { el.style.transition = 'none'; el.style.setProperty('--flag-w', '9999px'); }
      void stale[0].el.offsetWidth;   // 一次同步重排覆盖整批
      let drift = false;
      stale.forEach(({ p, el }, i) => {
        const nat = el.offsetWidth;
        el.__natW = nat; el.__natPaint = el.__paint; el.__natCompact = frame.compact;
        el.style.setProperty('--flag-w', prevs[i][0]);
        el.__fw = null;   // --flag-w 由本段临时改写 → 失效幂等缓存，下帧重写一次
        if (Math.abs(Math.min(nat, flagBaseW(p.title)) - p.w) > 0.75) drift = true;
      });
      void stale[0].el.offsetWidth;   // 上限归位后再结算一次
      // 过渡**下一帧**才恢复：若与取值同帧恢复，规范会按"新样式"为 9999→w 起一段滑回动画，
      // 后台标签页会把它冻在 9999px（盒宽＞上限、卡片互遮）——推迟恢复则后台保持 none（宽度正确），
      // 前台下一帧恢复且不会起滑回动画（rAF 冻结时由 visibilitychange 自愈兜底）
      requestAnimationFrame(() => { stale.forEach(({ el }, i) => { el.style.transition = prevs[i][1]; }); });
      if (drift && !widthRetry) {
        widthRetry = true;
        requestAnimationFrame(() => { widthRetry = false; layout(); });
      }
    }
    // （旗标池装配 / 逐条虚拟时刻 / first-fit 分道 / 三类聚簇 / z 重排 / 同道级联 / O 卡 A·B·C 三通道 /
    //   尾箭头取样 / 出界计数——全部收敛进引擎 timeline-layout.js，本文件不再保留第二份实现）

    lastTimelineView = { world: ctx.worldId, book: (ctx.currentPath || '').split('/')[0].replace(/\.md$/i, ''), lo: view.lo, hi: view.hi };
    if (DEV) {
      const ms = performance.now() - t0;
      const perf = window.__tlPerf = window.__tlPerf || { frames: 0, last: 0, avg: 0, max: 0, engine: 0, apply: 0, items: 0, placements: 0, nodes: 0, h: 0 };
      perf.frames++;
      perf.last = ms;
      perf.avg += (ms - perf.avg) / perf.frames;   // 累计均值（从载入/重置起）
      if (ms > perf.max) perf.max = ms;
      perf.engine += (pe1 - pe0 - perf.engine) / perf.frames;   // 分相：引擎 / 应用
      perf.apply += (pa1 - pe1 - perf.apply) / perf.frames;
      perf.items = items.length;
      perf.placements = frame.placements.length;
      perf.nodes = canvas.children.length + ticks.children.length + markers.children.length + eras.children.length;
      perf.h = hTarget;
    }
  }

  /** 应用一帧布局（引擎输出 → DOM）：元素池复用（跨 layout 只改样式）→ 缩放/改高平滑过渡；本函数不做任何布局计算。 */
  function applyFrame(frame) {
    const zh = state.lang === 'zh-CN';
    const COMPACT = frame.compact;
    // 刻度（第 77 轮：按 ord 元素复用 + 幂等写入；替换逐帧 innerHTML 全量重建）
    const seenTicks = new Set();
    for (const t2 of frame.ticks) {
      let el = tickEls.get(t2.ord);
      if (!el) { el = document.createElement('span'); el.className = 'tick'; tickEls.set(t2.ord, el); ticks.appendChild(el); }
      if (el.__px !== t2.px) { el.__px = t2.px; el.style.left = t2.px + 'px'; }
      if (el.__txt !== t2.text) { el.__txt = t2.text; el.textContent = t2.text; }
      seenTicks.add(t2.ord);
    }
    for (const [k, el] of tickEls) if (!seenTicks.has(k)) { el.remove(); tickEls.delete(k); }
    // 起止标记：范围首尾高刻度（edge）+ 打开文档起止（与标尺同款墨色）——同款复用
    const seenMarkers = new Set();
    for (const m of frame.markers) {
      let el = markerEls.get(m.ord);
      if (!el) { el = document.createElement('span'); markerEls.set(m.ord, el); markers.appendChild(el); }
      const cls = `tick chrono-marker-tick${m.edge ? ' edge' : ''}`;
      if (el.__cls !== cls) { el.__cls = cls; el.className = cls; }
      const title = m.kind === 'start' ? (zh ? '范围起点（最早时间）' : 'Range start')
        : m.kind === 'end' ? (zh ? '范围终点（最晚结束）' : 'Range end') : '';
      if (el.__title !== title) { el.__title = title; if (title) el.title = title; else el.removeAttribute('title'); }
      if (el.__px !== m.px) { el.__px = m.px; el.style.left = m.px + 'px'; }
      if (el.__txt !== m.text) { el.__txt = m.text; el.textContent = m.text; }
      seenMarkers.add(m.ord);
    }
    for (const [k, el] of markerEls) if (!seenMarkers.has(k)) { el.remove(); markerEls.delete(k); }
    // 覆盖条
    const shownSpans = new Set();
    for (const s of frame.spans) {
      let span = spanEls.get(s.path);
      if (!span) {
        span = document.createElement('div');
        span.dataset.path = s.path;
        spanEls.set(s.path, span);
        canvas.appendChild(span);
      }
      // 模糊 = 按端渐隐（§E.4）：引擎已按端解析 `*`（第 76 轮迁入数据层）
      span.className = `span-bar${s.fuzzyS ? ' fuzzy-s' : ''}${s.fuzzyE ? ' fuzzy-e' : ''}${s.isOpen ? ' open' : ''}`;
      span.style.left = s.left + 'px';
      span.style.width = s.width + 'px';
      span.title = s.title;
      shownSpans.add(s.path);
    }
    for (const [p0, el0] of [...spanEls]) if (!shownSpans.has(p0)) { el0.remove(); spanEls.delete(p0); }
    // 旗标（渲染 = 引擎最终排布列表，含簇；全世界创世在池内）
    // 第 77 轮：样式**幂等写入**（与元素缓存值比较，不变不写）——拖动时只有 left 逐帧变，其余全跳过
    const shownFlags = new Set();
    for (const p of frame.placements) {
      const flag = ensureFlagEl(p.path);
      const cls = `event-flag${p.isOpen ? ' open expand' : ''}${ctx.pins.has(p.path) ? ' pinned' : ''}${COMPACT ? ' compact' : ''}${!COMPACT && p.lane > 0 ? ' lane' : ''}`;
      if (flag.__cls !== cls) {
        flag.__cls = cls;
        flag.className = cls;   // 重写会清掉 axis-anchored → 下两行按 p.top 重新断言
        flag.__axis = null;
      }
      const anchored = p.top === 'axis';
      if (flag.__axis !== anchored) { flag.__axis = anchored; flag.classList.toggle('axis-anchored', anchored); }
      if (flag.__z !== p.z) { flag.__z = p.z; flag.dataset.z = String(p.z); }
      if (flag.__left !== p.left) { flag.__left = p.left; flag.style.left = p.left + 'px'; }
      if (flag.__top !== p.top) {
        flag.__top = p.top;
        if (anchored) { flag.style.top = 'auto'; flag.style.bottom = '6px'; }
        else { flag.style.top = p.top + 'px'; flag.style.bottom = 'auto'; }
      }
      const lead = (p.trueX - p.left + 10) + 'px';
      if (flag.__lead !== lead) { flag.__lead = lead; flag.style.setProperty('--lead-x', lead); }   // 引线始终垂在真实开始时刻
      const fw = p.w + 'px';
      if (flag.__fw !== fw) { flag.__fw = fw; flag.style.setProperty('--flag-w', fw); }             // 基础宽 = min(实测自然宽, 基准宽)
      // 打开中的卡片恒最上（z=80；expand 态也被显式置 80，不因 hover 逻辑漏设）——幂等写入；
      // hover 的 hot()/restore() 同步维护 __zi 缓存（第 77 轮）
      if (p.isOpen || !flag.classList.contains('expand')) {
        const wantZ = p.isOpen ? '80' : String(p.z);
        if (flag.__zi !== wantZ) { flag.__zi = wantZ; flag.style.zIndex = wantZ; }
      }
      if (flag.dataset.fresh === '1') {       // 新建卡片淡入（160ms；高分道展开/缩回时同样生效）
        flag.dataset.fresh = '';
        flag.classList.add('card-in');
        flag.addEventListener('animationend', () => flag.classList.remove('card-in'), { once: true });
      }
      paintFlag(flag, { eyebrow: p.eyebrow, title: p.title, date: p.date, fuzzy: p.fuzzy, pinned: ctx.pins.has(p.path) });
      // 聚合簇（§E.3）：点击=取景、hover 换成员名单、原生 title=全名单；解散（同元素复用键）时还原
      if (p.cluster) {
        flag.__clusterOrd = p.cluster.ord;
        flag.__clusterSpan = p.cluster.spanYears;   // 普通簇 = 成员跨度×3（≥1 年）；创世簇 = 全范围 25%
        flag.__baseTitle = p.title;
        flag.__altTitle = p.cluster.altTitle;
        flag.title = p.cluster.memberTitles.join('、');
      } else if (flag.__clusterSpan) {
        flag.__clusterSpan = null; flag.__altTitle = null; flag.__baseTitle = null;
        flag.title = '';
        const t2 = flag.querySelector('.flag-title');
        if (t2) t2.textContent = p.title;
      }
      shownFlags.add(p.path);
    }
    for (const [p0, el0] of [...flagEls]) if (!shownFlags.has(p0)) { el0.remove(); flagEls.delete(p0); }
    // 时代带（§3.2）：同 &a 条目的时间并集，bg/bg-soft 交替 + 名称；点击取景该时代；「更多设置」可关
    // 第 77 轮：按 era 名元素复用，点击 handler **一次性绑定**（读 el.__era，不再逐帧新建按钮/闭包）
    const eraOn = (ctx.settings?.axisEra ?? 'on') !== 'off';
    eras.style.display = eraOn ? '' : 'none';
    const seenEras = new Set();
    for (const e2 of frame.eras) {
      let seg = eraEls.get(e2.name);
      if (!seg) {
        seg = document.createElement('button');
        seg.addEventListener('pointerdown', (ev) => ev.stopPropagation());   // 不触发轴拖拽
        seg.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const cur2 = seg.__era;
          if (!cur2) return;
          const years = Math.max((cur2.hi - cur2.lo) / YEAR, 10);
          focusOrd((cur2.lo + cur2.hi) / 2, years);
        });
        eraEls.set(e2.name, seg);
        eras.appendChild(seg);
      }
      seg.__era = e2;   // lo/hi 每次刷新（点击时读取）
      if (seg.title !== e2.name) seg.title = e2.name;
      const cls = `era-band${e2.alt ? ' alt' : ''}`;
      if (seg.__cls !== cls) { seg.__cls = cls; seg.className = cls; }
      if (seg.__l !== e2.left) { seg.__l = e2.left; seg.style.left = e2.left + 'px'; }
      if (seg.__w !== e2.width) { seg.__w = e2.width; seg.style.width = e2.width + 'px'; }
      if (seg.__nameOn !== e2.showName) {
        seg.__nameOn = e2.showName;
        if (e2.showName) seg.innerHTML = `<span class="era-name">${esc(e2.name)}</span>`;
        else seg.textContent = '';
      }
      seenEras.add(e2.name);
    }
    for (const [k, el] of eraEls) if (!seenEras.has(k)) { el.remove(); eraEls.delete(k); }
    // 轴线段：只画 [最早时间, 最晚时间] 与视口的交集（范围外含创世区无线）
    axisLine.hidden = frame.axis.hidden;
    axisLine.style.left = frame.axis.left + 'px';
    axisLine.style.width = frame.axis.width + 'px';
    // 出界指示（◀ N / N ▶）：点击平滑取景把最近一批带回
    hintL.hidden = frame.hints.offL === 0;
    hintL.__ord = frame.hints.ordL;
    hintL.querySelector('.hint-n').textContent = String(frame.hints.offL);
    hintL.title = zh ? `还有 ${frame.hints.offL} 条在视野外 · 点击带回` : `${frame.hints.offL} off-screen · click to bring back`;
    hintR.hidden = frame.hints.offR === 0;
    hintR.__ord = frame.hints.ordR;
    hintR.querySelector('.hint-n').textContent = String(frame.hints.offR);
    hintR.title = zh ? `还有 ${frame.hints.offR} 条在视野外 · 点击带回` : `${frame.hints.offR} off-screen · click to bring back`;
    // 创世向左渐隐箭头（跟组左缘；组左缘已出屏时隐藏——箭头只标"组的左端在哪"）
    genesisTail.hidden = frame.tail.hidden;
    genesisTail.style.left = frame.tail.left + 'px';
    genesisTail.style.top = frame.tail.top + 'px';
  }

  /** 视野补间：300ms cubic-bezier(.22,1,.36,1)（≈easeOutCubic）；reduced-motion 瞬时。 */
  function animateTo(lo2, hi2, ms = 300) {
    if (anim) cancelAnimationFrame(anim);
    anim = null;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || ms <= 0) { view.lo = lo2; view.hi = hi2; layout(); return; }
    const lo0 = view.lo, hi0 = view.hi, t0 = performance.now();
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const k = ease(p);
      view.lo = lo0 + (lo2 - lo0) * k;
      view.hi = hi0 + (hi2 - hi0) * k;
      layout();
      anim = p < 1 ? requestAnimationFrame(step) : null;
    };
    anim = requestAnimationFrame(step);
  }

  /** 平移钳制（2026-10-06）：视野中心的时刻不得越过范围两端——左右端最多被拖到屏幕正中。
   *  以手势起点 ref 为软边界：已越界（取景开的创世同框等）时不回弹，只禁止继续越界。 */
  function clampPan(lo2, hi2, refLo, refHi) {
    if (earliestOrd == null || latestOrd == null) return [lo2, hi2];
    const span = hi2 - lo2;
    const refC = ((refLo ?? lo2) + (refHi ?? hi2)) / 2;
    const cMin = Math.min(earliestOrd, refC), cMax = Math.max(latestOrd, refC);
    const c = Math.min(Math.max((lo2 + hi2) / 2, cMin), cMax);
    return [c - span / 2, c + span / 2];
  }
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      const d = (e.deltaY / wrap.clientWidth) * (view.hi - view.lo);
      [view.lo, view.hi] = clampPan(view.lo + d, view.hi + d, view.lo, view.hi);
    } else {
      const anchor = view.lo + ((e.clientX - wrap.getBoundingClientRect().left) / wrap.clientWidth) * (view.hi - view.lo);
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const span = (view.hi - view.lo) * factor;
      const ratio = (anchor - view.lo) / (view.hi - view.lo);
      view.lo = anchor - span * ratio;
      view.hi = view.lo + span;
    }
    layout();
  }, { passive: false });

  let dragging = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.event-flag')) return;
    dragging = { x: e.clientX, lo: view.lo, hi: view.hi };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const d = ((e.clientX - dragging.x) / wrap.clientWidth) * (dragging.hi - dragging.lo);
    [view.lo, view.hi] = clampPan(dragging.lo - d, dragging.hi - d, dragging.lo, dragging.hi);
    layout();
  });
  const stop = () => { dragging = null; wrap.classList.remove('dragging'); };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);

  /** 取景补间：&s 落在屏幕 1/3、&e 落在屏幕 2/3（瞬时事件置于 1/3）。300ms。
   *  **打开条目不加取景**（2026-10-06 用户要求：删除所有条目点击的自动缩放；想看上哪条自己拖）+ 创世无时间语义不取景。
   *  仅剩「强调」拖拽（显式手势，把条目拖进屏幕）调用本函数。 */
  function focusPath(path) {
    const it = items.find((i) => i.path === path);
    if (!it) return;
    if (it.genesis) {   // 创世：取景到**虚拟时刻**（仅「强调」拖拽显式手势触发；打开条目不调用本函数）
      if (genesisOrd != null) focusOrd(genesisOrd, Math.max(((full.hi - full.lo) / YEAR) * LAYOUT.GENESIS_SPAN, 1));
      return;
    }
    const s = it.s;
    const e = it.e != null && it.e > it.s ? it.e : null;
    const dur = e != null ? e - s : Math.max(YEAR, (full.hi - full.lo) * LAYOUT.ZOOM_DUR_RATIO);
    animateTo(s - dur, (e ?? s) + dur, 300);
  }

  // 拖到时间轴 = 强调该条目
  wrap.addEventListener('dragover', (e) => {
    const from = ctx.dragPath || sessionStorage.getItem('soliterra.dragPath');
    if (!from) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    wrap.classList.add('drop-emphasis');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-emphasis'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop-emphasis');
    const from = ctx.dragPath || sessionStorage.getItem('soliterra.dragPath');
    if (from) emphasize(ctx, from);
  });

  /** ⌘K 日期取景：以 ord 为中心、spanYears 为跨度。 */
  function focusOrd(ord, spanYears = 100) {
    hoverBaseReset();
    const span = Math.max(spanYears * YEAR, YEAR);
    animateTo(ord - span / 2, ord + span / 2, 300);
  }
  function hoverBaseReset() { /* 预留：取景不参与 hover 还原 */ }

  // 键盘无障碍（§3.8）：T 聚焦时间轴 → ←/→ 平移、+/− 中心缩放、Esc 退出；旗标 Tab 聚焦=hover 同款
  wrap.tabIndex = -1;
  wrap.addEventListener('focus', () => wrap.classList.add('chrono-kb'));
  wrap.addEventListener('blur', () => wrap.classList.remove('chrono-kb'));
  if (axisKeyHandler) window.removeEventListener('keydown', axisKeyHandler);   // 单例：旧实例必须解绑（多 renderWorld 曾叠加多份 → 视图打架）
  axisKeyHandler = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 会话态 = class（T 显式管理，程序化 focus 在部分环境不可靠）或 真焦点
    const inAxis = wrap.classList.contains('chrono-kb') || document.activeElement === wrap;
    if (document.activeElement !== wrap && !wrap.classList.contains('chrono-kb')) wrap.classList.remove('chrono-kb');
    const k = e.key;
    if (!inAxis && (k === 't' || k === 'T')) {
      e.preventDefault();
      wrap.focus();
      wrap.classList.add('chrono-kb');                 // 程序化 focus 在部分环境不派发事件 → 显式管理
      return;
    }
    if (!inAxis) return;
    if (k === 'Escape') { wrap.blur(); wrap.classList.remove('chrono-kb'); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const d = (view.hi - view.lo) * (k === 'ArrowLeft' ? -0.1 : 0.1);
      animateTo(view.lo + d, view.hi + d, 150);
      return;
    }
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      e.preventDefault();
      const mid = (view.lo + view.hi) / 2;
      const span = (view.hi - view.lo) * ((k === '-' || k === '_') ? 1.3 : 1 / 1.3);
      animateTo(mid - span / 2, mid + span / 2, 150);
    }
  };
  window.addEventListener('keydown', axisKeyHandler);

  window.addEventListener('resize', layout);
  // 回前台自愈（第 76 轮）：后台标签页会冻结 CSS 过渡（max-width 悬停展开可卡在中间值、宽于上限）——
  // 回前台时关过渡 → 重排（写入目标上限）→ 强制结算 → 恢复过渡（数值未变，不会重新触发动画）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const el of flagEls.values()) el.style.transition = 'none';
    layout();
    void canvas.offsetWidth;
    for (const el of flagEls.values()) el.style.transition = '';
  });
  return {
    layout, focusPath, focusOrd, isTall: () => tall, view,
    setScope: () => { rescope(); layout(); },
    /** 是否为创世条目（打开创世 = 不动时间轴分毫的判断依据）。 */
    isGenesis: (p) => { const i = allItems.find((x) => x.path === p); return !!(i && i.genesis); },
    /** 数据刷新（元数据/工具改动后）：重取 timeline → 重建条目 → 范围重算（**视野不跳**）→ 重排。 */
    reload: (rows) => { if (rows) ctx.timeline = rows; allItems = buildItems(); rescope(true); layout(); },
  };
}

// ============ 结构操作（§5.4 ②③④ + 重命名/删除）：右键菜单 ============
async function refreshTree(ctx) {
  worldDataCache.delete(ctx.worldId);
  ctx.tree = await api(`/api/w/${enc(ctx.worldId)}/tree`);
  worldDataCache.set(ctx.worldId, { tree: ctx.tree, timeline: ctx.timeline, ts: Date.now() });
  renderToc(ctx);
  if (document.getElementById('books-grid')) renderBooksPanel(ctx);   // 书籍面板在场时同步重绘（第 79 轮：面板内改书后即时反映）
}

function closeTreeMenu() { document.querySelectorAll('.tree-menu').forEach((m) => m.remove()); }

function showTreeMenu(e, ctx, node) {
  e.preventDefault();
  closeTreeMenu();
  const menu = document.createElement('div');
  menu.className = 'tree-menu';
  const hasMd = !!node.md;
  const inDir = node.dir || '';
  const isDirNode = !!inDir && !hasMd;   // 纯目录节点（无同名 md，如「黄金时代/」）：第 80 轮起与书同等管理
  const zh = state.lang === 'zh-CN';
  const items = [];
  if (inDir) items.push(['add', zh ? '在此加条目' : 'Add entry here']);
  if (inDir && !hasMd) items.push(['child', zh ? '在此加子条目' : 'Add child entry']);
  else if (inDir) items.push(['child', zh ? '加子条目（建目录）' : 'Add child (with folder)']);
  if (isDirNode) items.push(['pair', zh ? '补建同名条目（成为书）' : 'Create paired entry']);
  if (hasMd || isDirNode) items.push(['rename', zh ? '重命名' : 'Rename']);
  if (hasMd || isDirNode) items.push(['del', zh ? '删除（移入回收站）' : 'Delete (trash)']);
  menu.innerHTML = items.map(([k, label]) => `<button class="tree-menu-item" data-k="${k}">${esc(label)}</button>`).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';

  const after = async (msg) => { await refreshTree(ctx); refreshGitStatus(ctx); showToast(msg, 'success'); };
  menu.addEventListener('click', async (ev) => {
    const k = ev.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    closeTreeMenu();
    try {
      if (k === 'add' || k === 'child') {
        const label = k === 'add' ? (state.lang === 'zh-CN' ? '条目名' : 'Entry name') : (state.lang === 'zh-CN' ? '子条目名' : 'Child name');
        const name = await askText(label);
        if (!name || !name.trim()) return;
        const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: inDir, name: name.trim(), pair: k === 'child' } });
        await after(state.lang === 'zh-CN' ? `已新建：${name.trim()}` : `Created: ${name.trim()}`);
        if (r2.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r2.path)}`);
      } else if (k === 'pair') {
        // 纯目录节点 → 补建同名条目（成为书：获得元数据位，菜单随即与其它书一致）
        const parent = inDir.includes('/') ? inDir.slice(0, inDir.lastIndexOf('/')) : '';
        const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: parent, name: node.name, pair: false } });
        await after(state.lang === 'zh-CN' ? `已补建：${node.name}.md` : `Paired: ${node.name}.md`);
        if (r2.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r2.path)}`);
      } else if (k === 'rename') {
        const cur = node.title || node.name;
        const nn = await askText(state.lang === 'zh-CN' ? '重命名为' : 'Rename to', cur);
        if (!nn || !nn.trim() || nn.trim() === cur) return;
        if (isDirNode) {
          // 纯目录节点：目录（+ 配对 md 若有）改名；当前条目在该书内 → 导航到新路径
          const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/rename`, { method: 'POST', body: { path: inDir, newName: nn.trim() } });
          await after(state.lang === 'zh-CN' ? '已重命名' : 'Renamed');
          if (ctx.currentPath && ctx.currentPath.startsWith(inDir + '/') && r2.path) {
            navigate(`#/w/${enc(ctx.worldId)}/${enc(r2.path + ctx.currentPath.slice(inDir.length))}`);
          }
          return;
        }
        await api(`/api/w/${enc(ctx.worldId)}/fs/rename`, { method: 'POST', body: { path: node.md, newName: nn.trim() } });
        await after(state.lang === 'zh-CN' ? '已重命名' : 'Renamed');
        const baseDir = node.md.replace(/[^/]+$/, '');
        navigate(`#/w/${enc(ctx.worldId)}/${enc(baseDir + nn.trim() + '.md')}`);
      } else if (k === 'del') {
        // 两步确认（不弹原生 confirm）
        const label = node.title || node.name;
        const conf = await askText(state.lang === 'zh-CN' ? `删除「${label}」？输入「删除」确认（将移入回收站）` : `Type 删除 to confirm deleting ${label}`);
        if (conf !== '删除') { if (conf !== null) showToast(state.lang === 'zh-CN' ? '未确认，未删除' : 'Not confirmed', 'warning'); return; }
        if (isDirNode) {
          await api(`/api/w/${enc(ctx.worldId)}/fs/delete`, { method: 'POST', body: { path: inDir } });
          await after(state.lang === 'zh-CN' ? '已移入回收站（.soliterra/trash-*）' : 'Moved to trash');
          if (ctx.currentPath && ctx.currentPath.startsWith(inDir + '/')) navigate(`#/w/${enc(ctx.worldId)}`);
          return;
        }
        await api(`/api/w/${enc(ctx.worldId)}/fs/delete`, { method: 'POST', body: { path: node.md } });
        await after(state.lang === 'zh-CN' ? '已移入回收站（.soliterra/trash-*）' : 'Moved to trash');
        if (ctx.currentPath === node.md) navigate(`#/w/${enc(ctx.worldId)}`);
      }
    } catch (err) { showToast(String(err.message), 'error'); }
  });
  const off = (ev) => { if (!menu.contains(ev.target)) { closeTreeMenu(); document.removeEventListener('pointerdown', off); } };
  document.addEventListener('pointerdown', off);
}

// ============ 目录树 ============
// 只显示当前书（顶层节点）的子树；递归展开到当前文档；子节点紧贴父级；行高亮当前文档。
function renderToc(ctx) {
  const body = document.getElementById('toc-body');
  if (!body) return;
  body.innerHTML = '';

  const topOf = (p) => (p || '').split('/')[0].replace(/\.md$/i, '');
  const currentTop = topOf(ctx.currentPath);
  const defaultBook = ctx.tree.children.find((c) => c.name === ctx.worldId) || ctx.tree.children[0] || null;
  const book = ctx.tree.children.find((c) => c.name === currentTop) || defaultBook;
  if (!book) return;

  // 当前文档是否在某节点子树内
  const containsCurrent = (node) => {
    if (node.md && node.md === ctx.currentPath) return true;
    return node.children.some(containsCurrent);
  };

  // 生成节点行（返回元素）
  const buildRow = (node, depth) => {
    const row = document.createElement('div');
    row.className = 'toc-row';
    row.style.paddingLeft = 16 + depth * 16 + 'px';
    const isOpenable = !!node.md;
    row.classList.toggle('openable', isOpenable);
    // 视图分级（§15.3）：读者视图下受限条目行淡化（点击仍可开，打开时占位卡）
    if (node.md === ctx.currentPath) row.classList.add('current');

    const arrow = document.createElement('span');
    arrow.className = 'toc-arrow';
    row.appendChild(arrow);
    const label = document.createElement('span');
    label.className = 'toc-label';
    label.textContent = node.title || node.name;
    row.appendChild(label);
    if (node.hasTime) {
      const dot = document.createElement('span');
      dot.className = 'toc-dot';
      dot.title = 'timeline';
      row.appendChild(dot);
    }
    if (isOpenable) row.addEventListener('click', () => { if (!window.__tocDragged) navigate(`#/w/${enc(ctx.worldId)}/${enc(node.md)}`); });

    // 右键 = 结构操作菜单（§5.4 ②③④）
    if (node.dir) row.addEventListener('contextmenu', (ev) => { if (!ev.target.closest('.toc-arrow')) showTreeMenu(ev, ctx, node); });

    // 拖动（pointer 实现，见 bindRowDrag）
    const movePath = node.children.length ? node.dir : (node.md || node.dir);
    row.dataset.dir = node.dir || '';
    row.dataset.path = node.md || '';
    if (movePath) bindRowDrag(row, ctx, movePath, node);

    // 子容器（紧贴父级之后）
    let sub = null;
    if (node.children.length) {
      sub = document.createElement('div');
      sub.className = 'toc-children';
      const expanded = depth === 0 ? true : (tocOpenDirs.has(node.dir) || containsCurrent(node));   // 自动展开到当前文档 + 记忆手动展开
      sub.hidden = !expanded;
      arrow.textContent = expanded ? '▾' : '▸';
      for (const child of node.children) sub.appendChild(buildRow(child, depth + 1));
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        sub.hidden = !sub.hidden;
        arrow.textContent = sub.hidden ? '▸' : '▾';
        if (sub.hidden) tocOpenDirs.delete(node.dir); else if (node.dir) tocOpenDirs.add(node.dir);
      });
      if (!isOpenable) row.addEventListener('click', () => { if (!window.__tocDragged) arrow.click(); });
    } else {
      arrow.textContent = '·';
      arrow.classList.add('leaf');
    }
    const wrapEl = document.createElement('div');
    wrapEl.className = 'toc-node';
    wrapEl.appendChild(row);
    if (sub) wrapEl.appendChild(sub);
    return wrapEl;
  };

  ensureTocDragGlobal(ctx);
  const bookRow = buildRow(book, 0);
  body.appendChild(bookRow);
  // 滚动到当前行
  requestAnimationFrame(() => {
    const cur = body.querySelector('.toc-row.current');
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'auto' });   // 瞬时定位：重建即到位，不播滚动动画（防闪烁）
  });
}

/** 目录定向更新：只把 .current 高亮从旧行挪到新行（同书内导航不重建目录）。 */
function updateTocCurrent(ctx, path) {
  const body = document.getElementById('toc-body');
  if (!body) return;
  const rows = [...body.querySelectorAll('.toc-row')];
  const hit = rows.find((r) => r.dataset.path === path || (r.dataset.dir || '') + '.md' === path);
  if (!hit) { renderToc(ctx); return; }   // 行不在当前树（如刚建的新文件）→ 兜底重建
  rows.forEach((r) => r.classList.toggle('current', r === hit));
  // 确保祖先展开
  let p2 = hit.parentElement;
  while (p2 && p2 !== body) {
    if (p2.classList?.contains('toc-children')) {
      p2.hidden = false;
      const prev = p2.previousElementSibling;
      const arrow = prev?.querySelector?.('.toc-arrow');
      if (arrow) arrow.textContent = '▾';
    }
    p2 = p2.parentElement;
  }
  hit.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

// ============ 阅读 ============
async function openEntry(ctx, path, chrono) {
  ctx.currentPath = path;
  const reader = document.getElementById('reader');
  reader.innerHTML = `<div class="loading">${t('world.loading')}</div>`;
  let e;
  try {
    e = await api(`/api/w/${enc(ctx.worldId)}/entry?path=${enc(path)}`);
  }
  catch (err) { reader.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; return; }

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
    // hover → 预览卡（220ms 延迟；进卡保持，离开缩回）
    let targetPath = a.dataset.resolved || null;
    a.addEventListener('mouseenter', async () => {
      const rect = a.getBoundingClientRect();
      if (!targetPath) {
        const r = await api(`/api/w/${enc(ctx.worldId)}/resolve?target=${enc(a.dataset.target)}`).catch(() => null);
        if (!r?.path) return;
        targetPath = r.path; a.dataset.resolved = r.path;
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
  const topOf2 = (p2) => (p2 || '').split('/')[0];
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

function flattenTree(node, out = []) {
  if (node.md) out.push({ path: node.md, title: node.title || node.name });
  for (const c of node.children) flattenTree(c, out);
  return out;
}
function nextEntry(tree, path) {
  const list = flattenTree(tree);
  const i = list.findIndex((x) => x.path === path);
  return i >= 0 ? list[i + 1] : null;
}
function prevEntry(tree, path) {
  const list = flattenTree(tree);
  const i = list.findIndex((x) => x.path === path);
  return i > 0 ? list[i - 1] : null;
}

// ============ 编辑（功能设计 §5 B 档：CM6 简化编辑器 + 装饰层；退出 = 一次 git 提交） ============
let editorModulePromise = null;
function loadEditor() {
  if (!editorModulePromise) editorModulePromise = import('/js/vendor/soliterra-editor.js');
  return editorModulePromise;
}

async function enterEdit(ctx) {
  ctx.editing = true;
  const { text } = await api(`/api/w/${enc(ctx.worldId)}/raw?path=${enc(ctx.currentPath)}`);
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
      </div>
      <div class="editor-host" id="editor-host"></div>
    </div>`;
  await loadEditor();
  window.__soliterraImgClick = (url, label) => openImagePaper(url, label);   // 编辑器缩略图 → 大图纸面
  window.__soliterraToast = (msg, kind) => showToast(msg, kind);
  const drawerD = debounce(() => renderMetaDrawer(ctx), 300);       // 抽屉重扫（§B.2 文档改动 300ms）
  ctx.editor = window.SoliterraEditor.create(document.getElementById('editor-host'), {
    doc: text,
    onChange: (t) => { scheduleAutoSave(ctx); drawerD(t); },
    getEntries: () => flattenTree(ctx.tree),   // [[ 触发双链补全
    lang: state.lang,                                              // §B.4 菜单文案语言
    uploadAsset: (file) => uploadAsset(ctx, file),                             // 粘贴/拖入上传（§B.5）
    resolveAsset: (src) => (/^(https?:)?\/\//.test(src) || src.startsWith('/') ? src : `/w/${enc(ctx.worldId)}/${enc(src)}`),
  });
  const host = document.getElementById('editor-host');
  new ResizeObserver(() => { /* CM6 自适应 */ }).observe(host);

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
    } else if (typeof ed[cmd] === 'function') {
      ed[cmd]();
    }
    updateEditorCount(ctx);
  });
  setEditFab(ctx, true);
  renderMetaDrawer(ctx);       // 抽屉初始渲染（§B.2）
}

/** 右下编辑 fab：阅读态 = 铅笔细线图标；编辑态 = 保存图标（「保存并退出」）。 */
function setEditFab(ctx, editing) {
  const fab = document.getElementById('fab-edit');
  if (!fab) return;
  fab.innerHTML = editing ? ICON.save : ICON.pencil;
  fab.title = editing ? t('reader.saveExit') : t('reader.edit');
  fab.classList.toggle('active', editing);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** 元数据改动后的时间轴数据刷新：重取 timeline（服务端已重索引）→ 原地重建条目与范围，视野不跳。 */
async function refreshTimeline(ctx) {
  worldDataCache.delete(ctx.worldId);
  try {
    const rows = await api(`/api/w/${enc(ctx.worldId)}/timeline`);
    ctx.chrono?.reload?.(rows);
  } catch {}
}

/** 自动保存调度（§「保存间隔」设置：500/1000/2000ms 或 0=仅保存并退出时落盘）——动态读取，即时生效。 */
let saveTimer = null;
function scheduleAutoSave(ctx) {
  clearTimeout(saveTimer);
  const ms = Number(ctx.settings?.saveDelay ?? 500) || 0;
  if (ms <= 0) return;
  saveTimer = setTimeout(() => autoSave(ctx), ms);
}

/** 防抖自动保存（不提交，静默）——保存后立即刷新时间轴（改 &s/&e 即刻上轴、范围随之更新）。 */
async function autoSave(ctx) {
  if (!ctx.editing || !ctx.editor) return;
  const ok = await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: ctx.currentPath, text: ctx.editor.getValue() } }).then(() => true).catch(() => false);
  if (ok) await refreshTimeline(ctx);
}

async function saveEdit(ctx) {
  if (!ctx.editor) return;
  await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: ctx.currentPath, text: ctx.editor.getValue() } });
}

async function exitEdit(ctx) {
  // 退出并保存（不提交——改动累计为未提交，提交在 + 面板）
  await saveEdit(ctx);
  await refreshTimeline(ctx);   // 编辑期改动（含 & 行）立即反映到时间轴与范围
  ctx.editing = false;
  if (ctx.editor) { try { ctx.editor.destroy(); } catch {} ctx.editor = null; }
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


/** 邻接表最短路（BFS）；返回路径上的 path 集合（含两端）或 null。 */
function bfsPath(adj, from, to) {
  if (!adj.has(from) || !adj.has(to)) return null;
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const nb of adj.get(cur) || []) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      q.push(nb);
    }
  }
  if (!prev.has(to)) return null;
  const out = new Set();
  for (let cur = to; cur != null; cur = prev.get(cur)) out.add(cur);
  return out;
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
      const top = (ctx.currentPath || '').split('/')[0].replace(/\.md$/i, '');
      try {
        const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: top, name, pair: false } });
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

// ============ 关系图（右 push：一跳邻里 + 拖动扯动 + 悬浮卡；「展开全图」= 全宽） ============
async function renderRel(ctx, mode) {
  const panel = document.getElementById('rel');
  if (!panel) return;
  ctx.graphMode = mode || ctx.graphMode || 'neighbor';
  const isFull = ctx.graphMode === 'full';
  ctx.relFull = isFull;
  document.getElementById('shell').classList.toggle('rel-full', isFull);

  let g;
  try {
    g = isFull
      ? await api(`/api/w/${enc(ctx.worldId)}/graph/all`)
      : await api(`/api/w/${enc(ctx.worldId)}/graph?path=${enc(ctx.currentPath)}${ctx.relBack ? '&backlinks=1' : ''}`);
  } catch { return; }

  const allTags = [...new Set(g.nodes.flatMap((n) => n.tags || []))].slice(0, 8);
  panel.innerHTML = `
    <div class="rel-toolbar">
      ${isFull ? `
        <input class="text-input rel-search" id="rel-search" placeholder="${state.lang === 'zh-CN' ? '搜索…' : 'Search…'}">
        <span class="rel-tags">${['全部', ...allTags].map((tg) => `<button class="rel-tag${(ctx.graphTag || '全部') === tg ? ' on' : ''}" data-tag="${esc(tg)}">${esc(tg)}</button>`).join('')}</span>
        <button class="icon-button" id="rel-back-mode">← ${state.lang === 'zh-CN' ? '收起' : 'Collapse'}</button>` : `
        ${checkHTML(!!ctx.relBack, lt('relBack'), 'id="rel-back-row"')}
        <button class="icon-button" id="rel-full">${lt('relFull')}</button>`}
      <button class="icon-button${ctx.graphLayout && ctx.graphLayout !== 'force' ? ' active' : ''}" id="rel-layout" title="${state.lang === 'zh-CN' ? '布局：力导向 → 按时间 → 按树分组（循环）' : 'Layout cycle: force → time → tree'}">${ctx.graphLayout === 'time' ? '⏱' : ctx.graphLayout === 'tree' ? '⌸' : '⟳'}</button>
      <span class="rel-count">${g.nodes.length} · ${g.edges.length}</span>
    </div>
    <div class="rel-canvas" id="rel-canvas">
      <div class="rel-viewport" id="rel-viewport">
        <svg class="rel-edges" id="rel-edges"></svg>
        <div class="rel-nodes" id="rel-nodes"></div>
      </div>
    </div>`;

  bindChecks(panel);
  panel.querySelector('#rel-back-row')?.addEventListener('click', () => {
    ctx.relBack = panel.querySelector('#rel-back-row').classList.contains('on');
    renderRel(ctx, 'neighbor');
  });
  panel.querySelector('#rel-full')?.addEventListener('click', () => renderRel(ctx, 'full'));
  panel.querySelector('#rel-layout')?.addEventListener('click', () => {
    ctx.graphLayout = ctx.graphLayout === 'time' ? 'tree' : ctx.graphLayout === 'tree' ? 'force' : 'time';
    renderRel(ctx);
  });
  panel.querySelector('#rel-back-mode')?.addEventListener('click', () => renderRel(ctx, 'neighbor'));
  panel.querySelectorAll('.rel-tag').forEach((b) => b.addEventListener('click', () => { ctx.graphTag = b.dataset.tag; renderRel(ctx, 'full'); }));
  panel.querySelector('#rel-search')?.addEventListener('input', () => applyFilter());

  if (g.nodes.length <= 1 && !isFull) {
    panel.querySelector('#rel-canvas').innerHTML = `<div class="empty-state">${lt('relEmpty')}</div>`;
    return;
  }
  if (g.nodes.length === 0) {
    panel.querySelector('#rel-canvas').innerHTML = `<div class="empty-state">${state.lang === 'zh-CN' ? '尚无任何双链' : 'No links yet'}</div>`;
    return;
  }

  const canvas = panel.querySelector('#rel-canvas');
  const svg = panel.querySelector('#rel-edges');
  const nodeLayer = panel.querySelector('#rel-nodes');
  const W = () => canvas.clientWidth || 480;
  const H = () => canvas.clientHeight || 480;

  // 邻接表（hover 强调用）
  const adj = new Map();
  for (const e of g.edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }

  for (const n of g.nodes) {
    const el2 = document.createElement('button');
    el2.className = `graph-node${n.center ? ' center' : ''}`;
    el2.textContent = n.title;
    el2.dataset.path = n.path;
    nodeLayer.appendChild(el2);
    n.el = el2;
  }
  const byId = new Map(g.nodes.map((n) => [n.path, n]));

  // 增量刷新（§9.0）：编辑保存后同图重渲染 → 既有节点位置保持、仅新增/失效的边 160ms 淡入/淡出。
  // 依据 = 上次同 world/模式/中心/含反链 的状态（livePos 随物理帧持续更新）。
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const relKey = { world: ctx.worldId, mode: ctx.graphMode, center: isFull ? '' : (ctx.currentPath || ''), back: !!ctx.relBack };
  const prev = ctx.relPrev;
  const refresh = !!(prev && prev.world === relKey.world && prev.mode === relKey.mode
    && prev.center === relKey.center && prev.back === relKey.back);
  const prevPos = refresh ? prev.pos : null;
  const livePos = new Map();
  const edgeIn = new Map();                          // 新增边：key → 起始时刻（淡入）
  const ghosts = [];                                 // 失效边：暂留 160ms 淡出
  const ekey = (e) => e.from + '\x00' + e.to;
  const curEdges = new Set(g.edges.map(ekey));
  if (refresh && !reduceMotion) {
    const now0 = performance.now();
    for (const e of g.edges) { const k = ekey(e); if (!prev.edges.has(k)) edgeIn.set(k, now0); }
    for (const k of prev.edges) if (!curEdges.has(k)) { const [f0, t0] = k.split('\x00'); ghosts.push({ from: f0, to: t0, t0: now0 }); }
  }

  function applyFilter() {
    const q = (panel.querySelector('#rel-search')?.value || '').trim();
    const tag = ctx.graphTag || '全部';
    for (const n of g.nodes) {
      if (!n.el) continue;
      const dim = isFull && tag !== '全部' && !(n.tags || []).includes(tag);
      n.el.classList.toggle('dim', dim);
      n.el.classList.toggle('hl', !!q && n.title.includes(q));
    }
  }
  applyFilter();

  // 布局：force（力导向，默认）或 time（按时间排布：x=时间序数、y=树深度；固定坐标）
  const timeOf = new Map((ctx.timeline || []).map((r) => [r.path, r.t_ord ?? null]));
  const depthOf = new Map();
  (function walk(node, d) { if (node.md) depthOf.set(node.md, d); for (const c of node.children) walk(c, d + 1); })(ctx.tree, 0);
  if (ctx.graphLayout === 'tree') {
    // 按树分组：x = 顶层书（按目录顺序分列），y = 组内顺序
    const bookOrder = (ctx.tree.children || []).map((c) => c.name);
    const groupOf = (p2) => (p2 || '').split('/')[0].replace(/\.md$/i, '');
    const groups = [...new Set(g.nodes.map((n) => groupOf(n.path)))].sort((a2, b2) => {
      const ia = bookOrder.indexOf(a2), ib = bookOrder.indexOf(b2);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    const colW = Math.max(1, W()) / Math.max(groups.length, 1);
    const idxIn = new Map();
    for (const n of [...g.nodes].sort((a2, b2) => a2.path.localeCompare(b2.path))) {
      const gk = groupOf(n.path);
      const i = idxIn.get(gk) || 0;
      idxIn.set(gk, i + 1);
      const x2 = Math.min(W() - 70, Math.max(70, colW * (groups.indexOf(gk) + 0.5)));
      const y2 = Math.min(Math.max(24, H() - 50), 24 + i * 46);
      n.fx = x2; n.fy = y2; n.x = x2; n.y = y2; n.vx = 0; n.vy = 0;
    }
  } else if (ctx.graphLayout === 'time') {
    const timed = g.nodes.filter((n) => typeof timeOf.get(n.path) === 'number');
    if (!timed.length) {
      ctx.graphLayout = 'force';
      showToast(state.lang === 'zh-CN' ? '本图无带 &s 的条目，无法按时间排布' : 'No timestamped entries', 'warning');
    } else {
      const vals = timed.map((n) => timeOf.get(n.path));
      const minS = Math.min(...vals), maxS = Math.max(...vals);
      const padX = 80, padY = 24;
      const usedX = new Map();                     // 同时刻节点纵向错位（不叠死）
      for (const n of g.nodes) {
        const s3 = timeOf.get(n.path);
        const x2 = typeof s3 !== 'number' ? padX
          : maxS === minS ? W() / 2
            : padX + ((s3 - minS) / (maxS - minS)) * Math.max(1, W() - padX * 2);
        const kx = Math.round(x2 / 40);
        const bump = usedX.get(kx) || 0;
        usedX.set(kx, bump + 1);
        const y2 = padY + (depthOf.get(n.path) || 0) * 56 + bump * 24;
        n.fx = x2; n.fy = Math.min(y2, Math.max(padY, H() - 50)); n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0;
      }
    }
  } else {
    for (const n of g.nodes) { n.fx = null; n.fy = null; }
  }
  // 初始布局：中心居中，其余环形（全图无中心 → 全部环形）——仅力导向。
  // 增量刷新：既有节点保持上一帧位置；新节点落在邻居质心附近并淡入（gn-in 160ms）。
  const cx0 = W() / 2, cy0 = H() / 2;
  const ring = Math.min(W(), H()) * (isFull ? 0.38 : 0.32);
  let freshIdx = 0;
  g.nodes.forEach((n, i) => {
    const fixed = n.fx != null;                      // 按时间/树布局：确定性坐标已固定
    const p = !fixed && prevPos ? prevPos.get(n.path) : null;
    if (fixed) { /* 布局坐标为权威 */ }
    else if (p) {                                    // 既有节点：位置保持（增量刷新的连续感）
      n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
      if (p.fx != null) { n.fx = p.fx; n.fy = p.fy; }
    } else if (n.center) { n.x = cx0; n.y = cy0; }
    else {
      const nb = refresh ? [...(adj.get(n.path) || [])].map((q) => byId.get(q)).filter((x) => x && x !== n) : [];
      if (nb.length) {                               // 新节点：邻居质心附近
        n.x = nb.reduce((s, x) => s + x.x, 0) / nb.length + (freshIdx % 2 ? 30 : -30);
        n.y = nb.reduce((s, x) => s + x.y, 0) / nb.length + freshIdx * 18;
      } else if (refresh) { n.x = cx0 + (freshIdx % 3 - 1) * 40; n.y = cy0 + freshIdx * 26; }
      else {
        const a = ((i - (g.nodes.some((x) => x.center) ? 1 : 0)) / Math.max(g.nodes.length - 1, 1)) * Math.PI * 2;
        n.x = cx0 + ring * Math.cos(a);
        n.y = cy0 + ring * Math.sin(a);
      }
      n.vx = 0; n.vy = 0;
      freshIdx++;
    }
    if (refresh && !fixed && !p && !reduceMotion) n.el?.classList.add('gn-in');
    livePos.set(n.path, { x: n.x, y: n.y, fx: n.fx ?? null, fy: n.fy ?? null });
  });

  let alpha = refresh ? 0.45 : 1;                    // 增量刷新：轻推力导向，不整体重排
  const K = isFull ? 70 : 90;
  function tick() {
    const nodes = g.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = Math.min(K * K / d, 50);
        const ux = dx / d, uy = dy / d;
        if (a.fx == null) { a.vx = (a.vx || 0) - ux * f; a.vy = (a.vy || 0) - uy * f; }
        if (b.fx == null) { b.vx = (b.vx || 0) + ux * f; b.vy = (b.vy || 0) + uy * f; }
      }
    }
    for (const e of g.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - (isFull ? 110 : 130)) * 0.05;
      const ux = dx / d, uy = dy / d;
      if (a.fx == null) { a.vx = (a.vx || 0) + ux * f; a.vy = (a.vy || 0) + uy * f; }
      if (b.fx == null) { b.vx = (b.vx || 0) - ux * f; b.vy = (b.vy || 0) - uy * f; }
    }
    const CX = W() / 2, CY = H() / 2;
    for (const n of g.nodes) {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; continue; }
      const gk = n.center ? 0.08 : 0.008;
      n.vx = (n.vx || 0) + (CX - n.x) * gk;
      n.vy = (n.vy || 0) + (CY - n.y) * gk;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx * alpha; n.y += n.vy * alpha;
      const pad = 8;
      n.x = Math.max(pad, Math.min(W() - n.el.offsetWidth - pad, n.x));
      n.y = Math.max(pad, Math.min(H() - n.el.offsetHeight - pad, n.y));
    }
    alpha = Math.max(alpha * 0.97, 0.02);
    const nowT = performance.now();
    for (const n of g.nodes) {
      n.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      const lp = livePos.get(n.path);
      if (lp) { lp.x = n.x; lp.y = n.y; lp.fx = n.fx ?? null; lp.fy = n.fy ?? null; }
      else livePos.set(n.path, { x: n.x, y: n.y, fx: n.fx ?? null, fy: n.fy ?? null });
    }
    const w = svg.clientWidth || W();
    svg.setAttribute('viewBox', `0 0 ${w} ${H()}`);
    const segOf = (a, b, op) => {
      const ax = a.x + a.el.offsetWidth / 2, ay = a.y + a.el.offsetHeight / 2;
      const bx = b.x + b.el.offsetWidth / 2, by = b.y + b.el.offsetHeight / 2;
      return { ax, ay, bx, by, style: op < 1 ? ` style="opacity:${op.toFixed(3)}"` : '' };
    };
    svg.innerHTML = g.edges.map((e) => {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) return '';
      const strong = e.kind === 'rel';
      const t1 = edgeIn.get(ekey(e));
      const op = t1 ? Math.min(1, (nowT - t1) / 160) : 1;   // 新增边 160ms 淡入
      const sg = segOf(a, b, op);
      const line = `<line x1="${sg.ax}" y1="${sg.ay}" x2="${sg.bx}" y2="${sg.by}" class="rel-edge${strong ? ' rel-edge-strong' : ''}"${sg.style} />`;
      const label = strong && e.type
        ? `<text x="${(sg.ax + sg.bx) / 2}" y="${(sg.ay + sg.by) / 2 - 3}" class="rel-edge-label" text-anchor="middle"${sg.style}>${esc(e.type)}</text>`
        : '';
      return line + label;
    }).join('') + ghosts.map((gh) => {
      const a = byId.get(gh.from), b = byId.get(gh.to);
      if (!a || !b) return '';
      const op = Math.max(0, 1 - (nowT - gh.t0) / 160);     // 失效边 160ms 淡出
      if (op <= 0) return '';
      const sg = segOf(a, b, op);
      return `<line x1="${sg.ax}" y1="${sg.ay}" x2="${sg.bx}" y2="${sg.by}" class="rel-edge"${sg.style} />`;
    }).join('');
    for (const [k, t1] of edgeIn) if (nowT - t1 >= 160) edgeIn.delete(k);
    for (let gi = ghosts.length - 1; gi >= 0; gi--) if (nowT - ghosts[gi].t0 >= 160) ghosts.splice(gi, 1);
  }

  // 滚轮缩放（锚点=指针）/ 拖空白平移 / 双击空白适应（k=1 居中）
  const vp = panel.querySelector('#rel-viewport');
  let k = 1, tx = 0, ty = 0;
  const applyT = () => { vp.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`; };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const nk = Math.min(4, Math.max(0.25, k * (e.deltaY > 0 ? 1 / 1.15 : 1.15)));
    tx = px - (px - tx) * (nk / k);
    ty = py - (py - ty) * (nk / k);
    k = nk;
    applyT();
  }, { passive: false });
  let panning = null;
  let boxSel = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.graph-node')) return;
    if (e.shiftKey) {   // Shift+拖空白 = 框选（§9.3）
      e.preventDefault();
      const r0 = canvas.getBoundingClientRect();
      const div = document.createElement('div');
      div.className = 'sel-box';
      canvas.appendChild(div);
      boxSel = { x0: e.clientX - r0.left, y0: e.clientY - r0.top, el: div };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    panning = { x: e.clientX, y: e.clientY, tx, ty };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (boxSel) {
      const r0 = canvas.getBoundingClientRect();
      const x1 = e.clientX - r0.left, y1 = e.clientY - r0.top;
      boxSel.el.style.left = Math.min(boxSel.x0, x1) + 'px';
      boxSel.el.style.top = Math.min(boxSel.y0, y1) + 'px';
      boxSel.el.style.width = Math.abs(x1 - boxSel.x0) + 'px';
      boxSel.el.style.height = Math.abs(y1 - boxSel.y0) + 'px';
      return;
    }
    if (!panning) return;
    tx = panning.tx + (e.clientX - panning.x);
    ty = panning.ty + (e.clientY - panning.y);
    applyT();
  });
  const endPan = () => {
    panning = null;
    if (boxSel) {
      const sr = boxSel.el.getBoundingClientRect();
      boxSel.el.remove();
      const picked = g.nodes.filter((n) => {
        const r = n.el.getBoundingClientRect();
        return r.left < sr.right && r.right > sr.left && r.top < sr.bottom && r.bottom > sr.top;
      });
      boxSel = null;
      showBoxActions(picked);
    }
  };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('dblclick', (e) => { if (e.target.closest('.graph-node')) return; k = 1; tx = 0; ty = 0; applyT(); });

  let pathA = null;
  // 框选操作条：加入稍后 / 只看选中 / 清除
  function showBoxActions(picked) {
    canvas.querySelector('.box-actions')?.remove();
    if (!picked.length) return;
    const bar = document.createElement('div');
    bar.className = 'box-actions';
    bar.innerHTML = `
      <span class="eyebrow">${state.lang === 'zh-CN' ? `已选 ${picked.length}` : `Picked ${picked.length}`}</span>
      <button class="button-ghost" data-a="later">✦ ${lt('dashLater')}</button>
      <button class="button-ghost" data-a="only">${state.lang === 'zh-CN' ? '只看这些' : 'Only these'}</button>
      <button class="button-ghost" data-a="export">${state.lang === 'zh-CN' ? '导出子图' : 'Export subgraph'}</button>
      <button class="icon-button" data-a="clear">${ICON.close}</button>`;
    canvas.appendChild(bar);
    bar.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-a]')?.dataset.a;
      if (!act) return;
      if (act === 'clear') { bar.remove(); return; }
      if (act === 'later') {
        let added = 0;
        for (const n of picked) {
          if ((ctx.readlater || []).some((x) => x.path === n.path)) continue;
          await addReadlater(ctx, n.path);
          added++;
        }
        showToast(`${added} ${state.lang === 'zh-CN' ? '条已加入稍后阅读' : 'added to read later'}`, 'success');
        return;
      }
      if (act === 'only') {
        const keep = new Set(picked.map((n) => n.path));
        for (const n of g.nodes) n.el.classList.toggle('dim', !keep.has(n.path));
        bar.remove();
      }
      if (act === 'export') {
        // 子图数据导出（节点 + 内部边 + 跨界边），PNG 需外部绘图库→数据形式先落地
        const keep = new Set(picked.map((n) => n.path));
        const sub = {
          center: picked.find((n) => n.center)?.path || picked[0]?.path || null,
          nodes: picked.map((n) => ({ path: n.path, title: n.title })),
          edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
          crossEdges: g.edges.filter((e) => (keep.has(e.from) && !keep.has(e.to)) || (!keep.has(e.from) && keep.has(e.to))),
          exportedAt: new Date().toISOString(),
        };
        download(`子图-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(sub, null, 2)], { type: 'application/json' }));
        showToast(state.lang === 'zh-CN' ? `已导出子图 JSON（${sub.nodes.length} 节点 · ${sub.edges.length} 内部边）` : 'Subgraph JSON exported', 'success');
      }
    });
  }

  /** 右键节点 = 中心化（锚定该节点、其余力导向围绕它重算）。 */
  function centerOn(n) {
    for (const x of g.nodes) {
      if (x.center) { x.center = false; x.fx = null; x.fy = null; x.el.classList.remove('center'); }
    }
    n.center = true;
    n.el.classList.add('center');
    n.fx = W() / 2; n.fy = H() / 2;
    n.x = n.fx; n.y = n.fy;
    alpha = 0.6;
    requestAnimationFrame(loop);
    showToast(state.lang === 'zh-CN' ? `已中心化：${n.title}` : `Centered: ${n.title}`, 'success');
  }
  canvas.addEventListener('click', (e) => {
    if (e.target.closest('.graph-node') || e.target.closest('.box-actions')) return;   // 操作条点击不触发清除
    pathA = null;
    for (const x2 of g.nodes) x2.el.classList.remove('on-path', 'dim');
  });

  let dragging = null;
  function loop() {
    if (!document.getElementById('rel-canvas')) return;
    tick();
    if (alpha > 0.03 || dragging) requestAnimationFrame(loop);
  }
  ctx.relPrev = { ...relKey, pos: livePos, edges: curEdges };   // 供下次「编辑保存 → 增量刷新」比对
  requestAnimationFrame(loop);
  // 面板宽度变化（拖动把手等）→ 重新加热仿真：节点/线条对齐（viewBox 随宽度重算）
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { alpha = Math.max(alpha, 0.35); requestAnimationFrame(loop); }).observe(canvas);
  }

  for (const n of g.nodes) {
    const el2 = n.el;
    el2.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = n;
      n.fx = n.x; n.fy = n.y;
      const r0 = canvas.getBoundingClientRect();
      n._gx = e.clientX - (r0.left + tx + n.x * k);   // 抓取偏移：拖拽时节点不瞬移，跟手
      n._gy = e.clientY - (r0.top + ty + n.y * k);
      n._dragMoved = false;                            // 本次交互是否发生拖动（用于抑制拖后误触打开）
      try { el2.setPointerCapture(e.pointerId); } catch {}
      el2.classList.add('dragging');
      hideCard();
    });
    el2.addEventListener('pointermove', (e) => {
      if (dragging !== n) return;
      const r = canvas.getBoundingClientRect();
      n.fx = (e.clientX - r.left - tx - n._gx) / k;
      n.fy = (e.clientY - r.top - ty - n._gy) / k;
      n.x = n.fx; n.y = n.fy;                          // 即时落位（不依赖仿真帧，跟手）
      n.vx = 0; n.vy = 0;
      n._dragMoved = true;
      el2.style.transform = `translate(${n.x}px, ${n.y}px)`;
      alpha = Math.max(alpha, 0.5);                    // 邻居流体跟随
      requestAnimationFrame(loop);
    });
    const up = () => {
      if (dragging === n) {
        dragging = null;
        /* 松手保持在落点（固定该节点）——不再弹回原平衡位；双击节点可解锁 */
        el2.classList.remove('dragging');
        alpha = Math.max(alpha, 0.25);
        requestAnimationFrame(loop);
      }
    };
    el2.addEventListener('pointerup', up);
    el2.addEventListener('pointercancel', up);

    // hover：一跳强调（邻接全亮，其余淡化）+ 悬浮卡
    el2.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      n.fx = null; n.fy = null;                        // 解锁：回到力导向自由移动
      alpha = Math.max(alpha, 0.4);
      requestAnimationFrame(loop);
    });
    el2.addEventListener('contextmenu', (e) => {       // 右键 = 中心化（§9.3）
      e.preventDefault();
      e.stopPropagation();
      centerOn(n);
    });
    el2.addEventListener('mouseenter', () => {
      const nb = adj.get(n.path) || new Set();
      for (const x of g.nodes) {
        if (x.el) x.el.classList.toggle('fade', x !== n && !nb.has(x.path));
      }
      showLinkCard(ctx, n.path, el2.getBoundingClientRect());
    });
    el2.addEventListener('mouseleave', () => {
      for (const x of g.nodes) if (x.el) x.el.classList.remove('fade');
      leaveAnchor();
    });
    el2.addEventListener('click', (e) => {
      if (n._dragMoved) { n._dragMoved = false; return; }   // 拖动结束的这次 click 不打开文档
      if (e.shiftKey) {                                     // Shift+单击：路径强调（两次点选两点）
        e.stopPropagation();
        if (!pathA) {
          pathA = n.path;
          for (const x2 of g.nodes) x2.el.classList.remove('on-path', 'dim');
          n.el.classList.add('on-path');
          showToast(state.lang === 'zh-CN' ? '路径强调：再 Shift+单击第二个节点' : 'Path: shift-click a second node', 'info');
        } else {
          const pathSet = bfsPath(adj, pathA, n.path);
          for (const x2 of g.nodes) {
            x2.el.classList.remove('on-path', 'dim');
            if (pathSet && pathSet.has(x2.path)) x2.el.classList.add('on-path');
            else x2.el.classList.add('dim');
          }
          pathA = null;
        }
        return;
      }
      navigate(`#/w/${enc(ctx.worldId)}/${enc(n.path)}`);
    });
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
  const tools = ['lint', 'date', 'brackets', 'drift', 'images', 'regex', 'dup'];
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
          ${['lint', 'date', 'brackets', 'drift', 'images', 'regex', 'dup'].map((tk, i) => `
          <button class="filter-button${i === 0 ? ' is-active' : ''}" data-tool="${tk}"><span>${lt(tk === 'lint' ? 'lintTitle' : ({ date: 'toolDate', brackets: 'toolBrackets', drift: 'toolDrift', images: 'toolImages', regex: 'toolRegex', dup: 'toolDup' })[tk])}</span><span class="tool-badge" data-badge="${tk}" hidden></span></button>`).join('')}
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
      ...fixRows.map((it, i) => `
      <div class="diff-row">
        ${checkHTML(it.checked, '', `data-i="${i}"`)}
        <span class="diff-path">${esc2(it.path)}:${it.line}</span>
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
      if (!it?.path) return;
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

// ============ 通用滚动指示条（替代原生滚动条：内容区顶部横向百分比条） ============
export function attachScrollIndicators(root) {
  const zones = (root || document).querySelectorAll(
    '.reader-column, .panel-scroll, .tools-list, .search-results, .modal-scroll, .editor-shell'
  );
  zones.forEach((zone) => {
    // 附着判据 = bar 实际存在（innerHTML 重写会删掉 bar；dataset 标记会误跳过重建——既有 bug，2026-10-06 修）
    if (zone.querySelector(':scope > .scroll-indicator')) return;
    const bar = document.createElement('div');
    bar.className = 'scroll-indicator';
    bar.innerHTML = '<span></span>';
    zone.prepend(bar);
    const span = bar.firstChild;
    let hideTimer = null;
    const update = () => {
      const ch = zone.scrollHeight, vh = zone.clientHeight;
      if (ch <= vh + 2) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      // 左端恒在面板最左；右端 = 文档顶端→屏幕底端已显示的百分比（进度条语义）
      const shown = Math.min(1, (zone.scrollTop + vh) / ch);
      span.style.width = (shown * 100) + '%';
      span.style.left = '0';
      // 滚动时出现，停止后延迟淡出
      bar.classList.add('active');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => bar.classList.remove('active'), 800);
    };
    zone.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(update).observe(zone);
    }
    update();
    zone.__updateScrollBar = update;
  });
}

/** 勾选组件：方形色块（选中变 ink）+ 紧挨文字矩形。 */
function checkHTML(checked, label, attrs = '') {
  return `<label class="check-row${checked ? ' on' : ''}" ${attrs}><span class="check-box"></span><span class="check-label">${label}</span></label>`;
}
function bindChecks(scope) {
  scope.querySelectorAll('.check-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      const input = row.querySelector('input');
      if (input) { input.checked = !input.checked; }
      row.classList.toggle('on');
      row.dispatchEvent(new CustomEvent('checkchange', { bubbles: true }));
    });
  });
}

/** 平台样式化输入弹层（替代原生 prompt）。resolve 输入值或 null（取消）。 */
export function askText(title, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog ask-dialog">
        <div class="modal-header">
          <span class="eyebrow">${esc(title)}</span>
          <button class="modal-close" data-close>×</button>
        </div>
        <div class="modal-scroll">
          <input class="text-input ask-input" value="${esc(defaultValue)}">
          <div class="modal-actions">
            <button class="button-ghost" data-close>${state.lang === 'zh-CN' ? '取消' : 'Cancel'}</button>
            <button class="button-primary" data-ok>${state.lang === 'zh-CN' ? '确定' : 'OK'}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const input = modal.querySelector('.ask-input');
    input.focus();
    input.select();
    const done = (v) => { modal.remove(); resolve(v); };
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => done(null)));
    modal.querySelector('[data-ok]').addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
  });
}

// 极简 toast（design.md 四语义色：3px 前缘 + 等宽标签）
function showToast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}


// ============ 树拖动（pointer 实现：上半=与目标同级/上移一级，下半=作为目标子级；拖到时间轴=强调） ============
let tocDrag = null;
let tocDragBound = false;

function bindRowDrag(row, ctx, movePath, node) {
  row.style.cursor = 'grab';
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.toc-arrow')) return;
    tocDrag = { movePath, node, sx: e.clientX, sy: e.clientY, active: false, row };
  });
}

function ensureTocDragGlobal(ctx) {
  if (tocDragBound) return;
  tocDragBound = true;
  const findRow = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.toc-row') : null;
  };
  const clearMarks = () => {
    document.querySelectorAll('.toc-row.drop-into, .toc-row.drop-sibling').forEach((n) => n.classList.remove('drop-into', 'drop-sibling'));
    document.querySelector('.chrono-bar')?.classList.remove('drop-emphasis');
  };

  document.addEventListener('pointermove', (e) => {
    if (!tocDrag) return;
    if (!tocDrag.active) {
      if (Math.hypot(e.clientX - tocDrag.sx, e.clientY - tocDrag.sy) < 5) return;
      tocDrag.active = true;
      document.body.classList.add('toc-dragging');
      const ghost = tocDrag.row.cloneNode(true);
      ghost.className = 'toc-drag-ghost';
      document.body.appendChild(ghost);
      tocDrag.ghost = ghost;
      window.__tocDragged = true;   // 抑制点击
      setTimeout(() => { window.__tocDragged = false; }, 400);
    }
    tocDrag.ghost.style.left = (e.clientX + 10) + 'px';
    tocDrag.ghost.style.top = (e.clientY + 6) + 'px';

    // drop 目标判定
    clearMarks();
    tocDrag.mode = null; tocDrag.target = null;
    const chrono = document.querySelector('.chrono-bar');
    if (chrono && document.elementFromPoint(e.clientX, e.clientY)?.closest('.chrono-bar')) {
      chrono.classList.add('drop-emphasis');
      tocDrag.mode = 'emphasize';
      return;
    }
    const row = findRow(e.clientX, e.clientY);
    if (row && row !== tocDrag.row && !row.contains(tocDrag.row)) {
      const r = row.getBoundingClientRect();
      const into = e.clientY > r.top + r.height / 2;   // 下半=移入；上半=同级（拖到父行上半=上移一级）
      row.classList.add(into ? 'drop-into' : 'drop-sibling');
      tocDrag.mode = into ? 'into' : 'sibling';
      tocDrag.target = row;
    }
  });

  document.addEventListener('pointerup', async (e) => {
    if (!tocDrag) return;
    const d = tocDrag;
    tocDrag = null;
    if (!d.active) return;   // 未达拖动阈值 = 普通点击
    d.ghost?.remove();
    document.body.classList.remove('toc-dragging');
    clearMarks();
    if (d.mode === 'emphasize') { emphasize(ctx, d.movePath); return; }
    if (!d.target) return;
    // 目标行的目录路径：row 的 dataset 存 node 信息（buildRow 设置）
    const targetDir = d.target.dataset.dir || '';
    const parentDir = targetDir.includes('/') ? targetDir.split('/').slice(0, -1).join('/') : '';
    const toDir = d.mode === 'into' ? targetDir : parentDir;   // 同级 = 移到目标父目录
    if (toDir === parentDirOf(d.movePath)) { return; }         // 已在目标层级
    await doMoveTo(ctx, d.movePath, toDir);
  });
}

function parentDirOf(p) {
  const clean = (p || '').replace(/\/$/, '');
  return clean.includes('/') ? clean.split('/').slice(0, -1).join('/') : '';
}

// ============ 树移动（拖动改层级）与时间轴强调（拖到时间轴） ============
async function doMoveTo(ctx, fromPath, toDir) {
  try {
    await api(`/api/w/${enc(ctx.worldId)}/fs/move`, { method: 'POST', body: { path: fromPath, toDir } });
    worldDataCache.delete(ctx.worldId);
    ctx.tree = await api(`/api/w/${enc(ctx.worldId)}/tree`);
    worldDataCache.set(ctx.worldId, { tree: ctx.tree, timeline: ctx.timeline, ts: Date.now() });
    renderToc(ctx);
    ctx.dragPath = null;
    sessionStorage.removeItem('soliterra.dragPath');
    refreshGitStatus(ctx);   // 移动 = 未提交改动
    showToast(state.lang === 'zh-CN' ? '已移动' : 'Moved', 'success');
  } catch (e) {
    showToast(String(e.message), 'error');
  }
}

/** 强调条目：拖到时间轴 → 持久保留在时间轴上（旗标 × 可取消）+ 聚焦 + 脉冲高亮。 */
function emphasize(ctx, path) {
  const it = ctx.timeline.find((i) => i.path === path);
  if (!it) {
    showToast(state.lang === 'zh-CN' ? '该条目暂无时间标记（&s/&e）' : 'No time markers (&s/&e) on this entry', 'warning');
    return;
  }
  ctx.pins.add(path);
  sessionStorage.setItem(`soliterra.pins.${ctx.worldId}`, JSON.stringify([...ctx.pins]));
  ctx.chrono?.focusPath(path);
  ctx.chrono?.layout();
  requestAnimationFrame(() => {
    document.querySelectorAll('.pulse').forEach((n) => n.classList.remove('pulse'));
    const nodes = [...document.querySelectorAll('.chrono-canvas [data-path]')].filter((n) => n.dataset.path === path);
    nodes.forEach((n) => n.classList.add('pulse'));
    showToast(state.lang === 'zh-CN' ? `已强调并保留在时间轴上：${it.title}` : `Pinned to timeline: ${it.title}`, 'success');
  });
}


// ============ §5.3 元数据结构化编辑（按键类型弹控件；返回最终值或 null） ============
const META_ENUM = {
  p: [['canon', '正典'], ['draft', '草稿'], ['disputed', '存疑'], ['deprecated', '废弃']],
  v: [['公众', '公众'], ['秘传', '秘传'], ['作者', '作者']],
  q: [['可靠', '可靠'], ['存疑', '存疑'], ['已证伪', '已证伪'], ['立场鲜明', '立场鲜明']],
};
const META_LABEL = { s: '起始时间', e: '结束时间', t: '标签', f: '事件分类', n: '标题', a: '时代', p: '状态', v: '可见性', q: '可信度', m: '封面图' };
// §B.2 元数据抽屉键表（与《全景时间轴与编辑器增强设计.md》§B.2 一致：名 / 解释 / 示例）
const META_KEY_DOC = {
  s: { zh: ['时间轴定位起点；`*` 为模糊段，公元前加 `-`', '0705.09.04'], en: ['Timeline start; * fuzzy, - for BCE', '0705.09.04'] },
  e: { zh: ['结束时间；缺省 = 瞬时事件（轴上一个点）', '0705.09.30'], en: ['End; omit = instant event', '0705.09.30'] },
  n: { zh: ['标题；不写则用文件名', '血色婚礼'], en: ['Title; defaults to filename', '血色婚礼'] },
  t: { zh: ['标签（空格分隔）；书籍分类与图筛选', '设定 世界本源'], en: ['Tags (space separated)', '设定'] },
  f: { zh: ['事件分类——时间轴旗标的分组维度', '灾变'], en: ['Flag group on the timeline', '灾变'] },
  a: { zh: ['时代——时间轴时代带，同代条目时间并集', '黄金时代'], en: ['Era band grouping', '黄金时代'] },
  p: { zh: ['状态（存英文 token）：canon / draft / disputed / deprecated', 'canon'], en: ['Status token: canon/draft/disputed/deprecated', 'canon'] },
  v: { zh: ['可见性——读者视图分级（存中文值）', '公众 / 秘传 / 作者'], en: ['Visibility (reader-view gating)', '公众/秘传/作者'] },
  q: { zh: ['可信度——卡片徽章前置（存中文值）', '可靠 / 存疑 / 已证伪'], en: ['Reliability badge', '可靠'] },
  m: { zh: ['封面图——assets/ 相对路径', 'assets/concepts/cover.png'], en: ['Cover image path', 'assets/…'] },
};
const META_ORDER = ['s', 'e', 'n', 't', 'f', 'a', 'p', 'v', 'q', 'm'];

/** 从文档文本解析 & 元数据（单行值断于下个键或行尾）→ Map<key, {value}>。 */
function parseMetaFromDoc(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!/^\s*&[a-z]/.test(line)) continue;
    const re = /&([a-z])(?:\s+([^&]*))?/g;
    let m;
    while ((m = re.exec(line))) map.set(m[1], { value: (m[2] || '').trim() });
  }
  return map;
}

/** 文本级改写单个元数据键（value 为空 = 删键；整行无键则删行）。编辑态与保存管线共用。 */
function applyMetaToText(text, key, value) {
  if (value === '' || value == null) {
    const re = new RegExp(`(^|\\s)&${key}(?=\\s|$)`);
    const out = [];
    for (const line of text.split('\n')) {
      if (!re.test(line)) { out.push(line); continue; }
      const nl = line
        .replace(new RegExp(`(^|\\s)&${key}\\s*[^&]*`), '$1')
        .replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
      if (nl.trim() === '' || nl.trim() === '&') continue;      // 行里没别的键了 → 删行
      out.push(nl);
    }
    return out.join('\n');
  }
  const kv = new RegExp(`&${key}\\s+[^&\\n]*`);
  if (kv.test(text)) return text.replace(kv, `&${key} ${value} `);
  return `&${key} ${value}\n` + text;                           // 键不存在 → 插入文档头
}

/** 在文档的 & 行区插入空键 `&k `（追加到最后一个 & 行尾；无 & 行则插入文档头）；返回新文本。 */
function insertMetaIntoText(text, key) {
  const lines = text.split('\n');
  let lastMetaIdx = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*&[a-z]/.test(lines[i])) lastMetaIdx = i;
  if (lastMetaIdx >= 0) {
    lines[lastMetaIdx] = `${lines[lastMetaIdx].replace(/\s+$/, '')} &${key} `;
    return lines.join('\n');
  }
  return `&${key} \n${text}`;
}

/** 保存元数据：编辑态写回 CM6 编辑器（不重渲染，防抖自动保存）；阅读态走服务端 + 原地重载。 */
async function saveMetaFromEditor(ctx, key, value) {
  if (ctx.editing && ctx.editor) {
    const cur = ctx.editor.getValue();
    const next = applyMetaToText(cur, key, value);
    if (next !== cur) ctx.editor.setValue(next);                // CM6 内一个事务（⌘Z 可撤）→ onChange 触发保存与抽屉重扫
    return;
  }
  await editMetaValue(ctx, key, value);
}

/** 元数据抽屉（§B.2 编辑态顶条）：chips 即点即改 + 末尾「＋」添加。文档改动后防抖重扫。 */
function renderMetaDrawer(ctx) {
  const host = document.getElementById('meta-drawer');
  if (!host || !ctx.editing || !ctx.editor) return;
  let meta;
  try { meta = parseMetaFromDoc(ctx.editor.getValue()); } catch { return; }
  const keys = [...META_ORDER.filter((k) => meta.has(k)), ...[...meta.keys()].filter((k) => !META_ORDER.includes(k))];
  host.innerHTML = keys.map((k) => {
    const v = meta.get(k)?.value || '';
    const known = META_ORDER.includes(k);
    return `<button class="md-chip${v ? '' : ' empty'}${known ? '' : ' custom'}" data-k="${esc(k)}" title="${esc(META_LABEL[k] || '自定义键')}">
      <span class="k">&${esc(k)}</span><span class="v">${v ? esc(v) : '—'}</span></button>`;
  }).join('') + `<button class="md-add" id="md-add" title="${state.lang === 'zh-CN' ? '添加元数据' : 'Add metadata'}">＋</button>`;
  host.querySelectorAll('.md-chip').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.k;
    const val = await openMetaEditor(ctx, k, meta.get(k)?.value || '');
    if (val === null) return;
    await saveMetaFromEditor(ctx, k, val.trim());
  }));
  host.querySelector('#md-add')?.addEventListener('click', () => openAddMeta(ctx));
}

/** 「＋ 添加元数据」菜单：键表（名+解释+示例）；已存在 → 开其编辑卡，否则插入 `&k ` 光标值位。 */function openAddMeta(ctx) {
  const { close, body } = openPaperDialog2('＋ ' + (state.lang === 'zh-CN' ? '添加元数据' : 'Add metadata'));
  const zh = state.lang !== 'en';
  let meta = new Map();
  try { meta = parseMetaFromDoc(ctx.editor?.getValue() || ''); } catch {}
  const rowHTML = (k, name, doc2) => `<button class="am-row" data-k="${esc(k)}" ${meta.has(k) ? 'data-exists="1"' : ''}>
      <span class="am-key">&${esc(k)}</span><span class="am-name">${esc(name)}</span>
      <span class="am-desc">${esc(doc2[0])}</span><span class="am-ex">${esc(doc2[1] || '')}</span></button>`;
  body.innerHTML = `
    <div class="am-list">
      ${META_ORDER.map((k) => rowHTML(k, META_LABEL[k], META_KEY_DOC[k] ? META_KEY_DOC[k][zh ? 'zh' : 'en'] : ['', ''])).join('')}
    </div>
    <div class="am-custom">
      <input class="text-input" id="am-key" maxlength="1" placeholder="${state.lang === 'zh-CN' ? '自定义键（单个小写字母）' : 'Custom key (one lowercase letter)'}">
      <button class="button-ghost" id="am-ok">${state.lang === 'zh-CN' ? '插入' : 'Insert'}</button>
    </div>`;
  const addKey = async (k) => {
    if (!/^[a-z]$/.test(k)) { showToast(state.lang === 'zh-CN' ? '键须为单个小写字母' : 'Single lowercase letter', 'warning'); return; }
    close();
    if (meta.has(k)) {                                      // 已存在 → 开编辑卡
      const val = await openMetaEditor(ctx, k, meta.get(k).value || '');
      if (val !== null) await saveMetaFromEditor(ctx, k, val.trim());
      return;
    }
    if (!ctx.editor?.insertMetaLine) { showToast(state.lang === 'zh-CN' ? '请在编辑态使用' : 'Editor only', 'warning'); return; }
    ctx.editor.insertMetaLine(k);                           // 插 `&k ` 到 & 行区并聚焦值位（一个事务可撤）
    renderMetaDrawer(ctx);
  };
  body.querySelectorAll('.am-row').forEach((b) => b.addEventListener('click', () => addKey(b.dataset.k)));
  body.querySelector('#am-ok').addEventListener('click', () => addKey(body.querySelector('#am-key').value.trim().toLowerCase()));
  body.querySelector('#am-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKey(body.querySelector('#am-key').value.trim().toLowerCase()); });
}

const DATE_RE = /^-?\d{1,4}\.(\d{2}|\*)\.(\d{2}|\*)$/;

function openMetaEditor(ctx, key, current) {
  return new Promise((resolve) => {
    const isDate = key === 's' || key === 'e';
    const isTags = key === 't';
    const seg = META_ENUM[key];
    const flagCats = [...new Set(ctx.timeline.map((r) => r.flag).filter(Boolean))];
    const bookTags = [...new Set((ctx.tree.children || []).flatMap((b) => b.tags || []))];
    let tags = isTags ? String(current || '').split(/\s+/).filter(Boolean) : [];
    const kdoc = META_KEY_DOC[key];
    const explain = kdoc ? (state.lang === 'en' ? kdoc.en[0] : kdoc.zh[0]) : '';
    const example = kdoc ? (state.lang === 'en' ? kdoc.en[1] : kdoc.zh[1]) : '';
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog ask-dialog">
        <div class="modal-header"><span class="eyebrow">&amp;${esc(key)} · ${esc(META_LABEL[key] || (state.lang === 'en' ? 'Custom key' : '自定义键'))}</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-scroll">
          ${explain ? `<p class="meta-explain">${esc(explain)}${example ? ` <span class="meta-ex-example">例：${esc(example)}</span>` : ''}</p>` : ''}
          ${isDate ? `
            <input class="text-input meta-date" value="${esc(current)}" placeholder="yyyy.mm.dd（* 为模糊段，如 0705.*.*）">
            <div class="meta-hint" hidden></div>
            <div class="meta-quick">
              <button class="button-ghost" type="button" data-fuzzy-year>日段模糊</button>
              <button class="button-ghost" type="button" data-fuzzy-all>年月日全模糊</button>
            </div>` : ''}
          ${seg ? `
            <div class="seg meta-seg">${seg.map(([v2, label]) => `<button type="button" data-val="${esc(v2)}" class="${current === v2 ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>
            <input class="text-input meta-text" value="${esc(current)}" placeholder="或输入自定义值">` : ''}
          ${isTags ? `
            <div class="meta-chips">${tags.map((t2) => `<span class="meta-chip">${esc(t2)}<button type="button" data-del="${esc(t2)}">×</button></span>`).join('') || '<span class="meta-chip empty">—</span>'}</div>
            <input class="text-input meta-text" list="meta-tag-list" placeholder="输入标签后回车（可多选）">
            <datalist id="meta-tag-list">${bookTags.map((t2) => `<option value="${esc(t2)}">`).join('')}</datalist>` : ''}
          ${!isDate && !seg && !isTags ? `
            <input class="text-input meta-text" value="${esc(current)}" ${key === 'f' ? 'list="meta-flag-list"' : ''} placeholder="${key === 'm' ? 'assets/… 图片路径' : ''}">
            ${key === 'f' ? `<datalist id="meta-flag-list">${flagCats.map((f2) => `<option value="${esc(f2)}">`).join('')}</datalist>` : ''}` : ''}
          <div class="modal-actions">
            <button class="button-ghost meta-del" data-del-key>${state.lang === 'en' ? 'Delete key' : '删除该键'}</button>
            <button class="button-ghost" data-close>取消</button>
            <button class="button-primary" data-ok>确定</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const dateInput = modal.querySelector('.meta-date');
    const hint = modal.querySelector('.meta-hint');
    const okBtn = modal.querySelector('[data-ok]');
    const done = (v) => { modal.remove(); resolve(v); };

    const validateDate = () => {
      if (!dateInput) return true;
      const v = dateInput.value.trim();
      const ok = v === '' || DATE_RE.test(v);
      dateInput.classList.toggle('invalid', !ok);
      okBtn.disabled = !ok;
      if (hint) { hint.hidden = ok || v === ''; hint.textContent = ok ? '' : '不合规：应为 yyyy.mm.dd（可含 * 段），如 0705.09.04'; }
      return ok;
    };
    if (dateInput) {
      dateInput.addEventListener('input', validateDate);
      validateDate();
      modal.querySelector('[data-fuzzy-year]')?.addEventListener('click', () => {
        const m2 = dateInput.value.trim().match(/^(-?\d{1,4})\.(\d{2})\.(\d{2})$/);
        if (m2) dateInput.value = `${m2[1]}.${m2[2]}.*`;
        validateDate();
      });
      modal.querySelector('[data-fuzzy-all]')?.addEventListener('click', () => {
        const m2 = dateInput.value.trim().match(/^(-?\d{1,4})/);
        if (m2) dateInput.value = `${m2[1]}.*.*`;
        validateDate();
      });
    }
    // 枚举下拉 + 自定义
    const segBtns = [...modal.querySelectorAll('.meta-seg button')];
    segBtns.forEach((b) => b.addEventListener('click', () => {
      const on = b.classList.contains('on');
      segBtns.forEach((x) => x.classList.remove('on'));
      if (!on) b.classList.add('on');
      const custom = modal.querySelector('.meta-text');
      if (custom) custom.value = on ? '' : b.dataset.val;
    }));
    const custom = modal.querySelector('.meta-text');
    if (custom && segBtns.length) custom.addEventListener('input', () => segBtns.forEach((x) => x.classList.remove('on')));
    // 标签 chips
    if (isTags) {
      const rerender = () => {
        modal.querySelector('.meta-chips').innerHTML = tags.map((t2) => `<span class="meta-chip">${esc(t2)}<button type="button" data-del="${esc(t2)}">×</button></span>`).join('') || '<span class="meta-chip empty">—</span>';
        modal.querySelectorAll('[data-del]').forEach((b2) => b2.addEventListener('click', () => { tags = tags.filter((x) => x !== b2.dataset.del); rerender(); }));
      };
      custom?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = custom.value.trim();
        if (v && !tags.includes(v)) { tags.push(v); rerender(); }
        custom.value = '';
      });
      rerender();
    }
    const collect = () => {
      if (isDate) return dateInput.value.trim();
      if (isTags) {
        const pending = custom?.value.trim();
        const all = pending && !tags.includes(pending) ? [...tags, pending] : tags;
        return all.join(' ');
      }
      if (segBtns.some((b) => b.classList.contains('on'))) return segBtns.find((b) => b.classList.contains('on')).dataset.val;
      return custom ? custom.value.trim() : '';
    };
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => done(null)));
    modal.querySelector('[data-del-key]')?.addEventListener('click', () => done(''));   // 空串 = 删键（§5.3）
    okBtn.addEventListener('click', () => { if (!validateDate()) return; done(collect()); });
    const inp = modal.querySelector('.text-input');
    inp?.focus(); inp?.select?.();
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && !isTags) { if (!validateDate()) return; done(collect()); }
    });
  });
}

/** 编辑单个元数据键：更新其 & 行中的值并保存（同行其他键保留）。 */
async function editMetaValue(ctx, key, value) {
  let raw = ctx.currentRaw || '';
  raw = applyMetaToText(raw, key, value);   // value 空 = 删键（整行无键则删行）；否则同行改值/头部插入
  try {
    await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: ctx.currentPath, text: raw } });
    refreshGitStatus(ctx);
    await refreshTimeline(ctx);   // 元数据改完即刻上轴（含范围重算）
    await openEntry(ctx, ctx.currentPath, ctx.chrono);   // 原地重载正文（不重建面板；打开本就不取景）
  } catch (err) { showToast(String(err.message), 'error'); }
}
