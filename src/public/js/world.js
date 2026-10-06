// 世界内工作台（功能设计 §2/§3/§4/§7/§8/§10/§11）
// 布局：时间轴（顶部通栏）+ 主区 push（目录/关系图）+ 四角：
//   左上世界卡（peek 左）· 左下设置面板（peek 左）· 左下角书架（cover-first）· 右侧稍后阅读区（peek 右）· 右下操作栏。

import { api, t, state, navigate, bindCoverFallbacks } from './app.js';
import { showLinkCard, hideCard, leaveAnchor } from './linkcard.js';
import { attachTilt } from './home.js';
import { download, subtreePaths, mdToTxt, buildEpub } from './exporter.js';

const YEAR = 365.25;
// 世界数据缓存（tree/timeline 变化少）：导航重渲染几乎同步 → 消除闪屏
const worldDataCache = new Map();   // worldId -> { tree, timeline, ts }
const tocOpenDirs = new Set();    // 目录手动展开的目录（跨重渲染记忆，防闪回）
let activeWorld = null;           // { id, update(path) }：同世界导航走原地更新（不整页重载）
let lastEntry = null;            // { world, path }：同一文档重渲染（退出编辑等）→ 跳过取景动画并恢复视野
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
        <button class="fab" id="fab-tools" title="${lt('tools')}">${ICON.tools}<span class="fab-badge" hidden></span></button>
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
  refreshLintBadge(ctx);

  // 时间轴高度（可拖动；最矮 56 限定）：56–320px，sessionStorage 记忆
  const chronoH = parseInt(sessionStorage.getItem('soliterra.chronoH') || '112', 10);
  root.querySelector('.world-view').style.setProperty('--chrono-h', Math.min(320, Math.max(70, chronoH)) + 'px');   // 最矮 70 = 画布 42 + 刻度 28
  ctx.skipFrame = !!(lastEntry && lastEntry.world === worldId && lastEntry.path === entryPath);
  lastEntry = { world: worldId, path: entryPath };
  const chrono = initTimeline(ctx, el('chrono'), el('chrono-canvas'), el('chrono-ticks'));
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
    const collapsed = (ctx.settings?.axisCollapse ?? 'on') !== 'off' && readerCol.scrollTop > 80;
    root.querySelector('.world-view').classList.toggle('shrunk', collapsed);
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
    document.getElementById('toc-add-book')?.addEventListener('click', async () => {
      const name = await askText(state.lang === 'zh-CN' ? '新书名' : 'Book name');
      if (!name || !name.trim()) return;
      try {
        const r = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: '', name: name.trim(), pair: true } });
        await refreshTree(ctx);
        refreshGitStatus(ctx);
        showToast(state.lang === 'zh-CN' ? `已建书：${name}` : `Book created: ${name}`, 'success');
        if (r.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r.path)}`);
      } catch (e) { showToast(String(e.message), 'error'); }
    });
  } else if (name === 'world') {
    host.innerHTML = `<div class="panel-scroll" id="wp-embed"></div>`;
    renderWorldPanel(ctx);
  } else if (name === 'books') {
    host.innerHTML = `
      ${resize()}
      <div class="panel-head"><span class="eyebrow">${lt('shelfAll')}</span><span class="panel-count" id="books-count"></span></div>
      <div class="books-filter" id="books-filter"></div>
      <div class="panel-scroll"><div class="books-grid" id="books-grid"></div></div>`;
    renderBooksPanel(ctx);
    bindPanelResize(ctx, 'left', '--books-w', 'soliterra.booksW');
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
    const move = (ev) => {
      const h = Math.min(320, Math.max(70, startH + (ev.clientY - startY)));   // 画布最小 42
      root.querySelector('.world-view').style.setProperty('--chrono-h', Math.round(h) + 'px');
      sessionStorage.setItem('soliterra.chronoH', String(Math.round(h)));
      chrono.layout();
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
      <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '视图' : 'View'}</span>
        <div class="seg" data-set="view">
          <button data-val="author">${state.lang === 'zh-CN' ? '作者' : 'Author'}</button>
          <button data-val="reader">${state.lang === 'zh-CN' ? '读者' : 'Reader'}</button>
        </div></div>
      <div class="set-row"><span class="eyebrow">${lt('language')}</span>
        <div class="seg" data-lang></div>
      </div>
      <div class="set-row wp-more-row"><button class="button-ghost wp-more" id="wp-more">${lt('moreSettings')} <span class="wp-more-arr">▸</span></button></div>
      <div class="wp-more-body" id="wp-more-body" hidden>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '编辑器' : 'Editor'}</span>
          <div class="seg" data-set="editor"><button data-val="std">${state.lang === 'zh-CN' ? '标准' : 'Std'}</button><button data-val="min">${state.lang === 'zh-CN' ? '极简' : 'Min'}</button></div></div>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '时代带' : 'Era band'}</span>
          <div class="seg" data-set="axisEra"><button data-val="on">${state.lang === 'zh-CN' ? '开' : 'On'}</button><button data-val="off">${state.lang === 'zh-CN' ? '关' : 'Off'}</button></div></div>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '智能收拢' : 'Smart shrink'}</span>
          <div class="seg" data-set="axisCollapse"><button data-val="on">${state.lang === 'zh-CN' ? '开' : 'On'}</button><button data-val="off">${state.lang === 'zh-CN' ? '关' : 'Off'}</button></div></div>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '目录展开' : 'TOC depth'}</span>
          <div class="seg" data-set="tocDepth"><button data-val="1">1</button><button data-val="2">2</button><button data-val="3">3</button></div></div>
      </div>`;
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
        if (key === 'axisCollapse' && b.dataset.val === 'off') document.querySelector('.world-view')?.classList.remove('shrunk');
        if (key === 'tocDepth' && ctx.panel === 'toc') renderToc(ctx);   // 展开深度：即时重建树
        if (key === 'view') location.reload();   // 视图分级在渲染层生效 → 重载当前条目
      });
    });
  });
  const moreBtn = scope.querySelector('#wp-more');
  const moreBody = scope.querySelector('#wp-more-body');
  if (moreBtn && moreBody) moreBtn.addEventListener('click', () => {
    moreBody.hidden = !moreBody.hidden;
    const arr = moreBtn.querySelector('.wp-more-arr');
    if (arr) arr.textContent = moreBody.hidden ? '▸' : '▾';
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

/** lint 警报计数（§11）：工具 fab 角标——有 error 显红、否则 warn 显黄、0 隐藏。 */
async function refreshLintBadge(ctx) {
  const badge = document.querySelector('#fab-tools .fab-badge');
  if (!badge) return;
  try {
    const { items } = await api(`/api/w/${enc(ctx.worldId)}/tools/scan?tool=lint`);
    const errs = items.filter((i) => i.severity === 'error').length;
    const warns = items.filter((i) => i.severity === 'warn').length;
    if (errs) { badge.hidden = false; badge.className = 'fab-badge err'; badge.textContent = errs > 9 ? '9+' : String(errs); }
    else if (warns) { badge.hidden = false; badge.className = 'fab-badge warn'; badge.textContent = warns > 9 ? '9+' : String(warns); }
    else badge.hidden = true;
    badge.title = `lint · ${errs} error · ${warns} warn`;
  } catch { badge.hidden = true; }
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
      card.addEventListener('click', () => {
        const b = books.find((x) => x.name === card.dataset.name);
        const first = b ? firstEntryOf(b) : null;
        if (!first) return;
        sessionStorage.setItem('soliterra.panel', 'toc');
        if (first === ctx.currentPath) setPanel(ctx, 'toc');
        else navigate(`#/w/${enc(ctx.worldId)}/${enc(first)}`);
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
  const items = ctx.timeline.map((r) => ({ ...r, s: parseOrd(r.start), e: parseOrd(r.end), era: r.era || null })).filter((r) => r.s != null);
  let lo = 0, hi = 1;
  if (items.length) {
    lo = Math.min(...items.map((i) => i.s));
    hi = Math.max(...items.map((i) => i.e ?? i.s));
    const pad = (hi - lo) * 0.05 || YEAR;
    lo -= pad; hi += pad;
  }
  const view = { lo, hi };
  // 从**当前视图**出发（不跳回默认全库初值）：同一世界重渲染沿用上次视野，
  // 之后由 openEntry 的取景补间「从现在的值移动/缩放到目标」；同文档重渲染则不再取景（skipFrame）
  if (lastTimelineView && lastTimelineView.world === ctx.worldId) {
    view.lo = lastTimelineView.lo; view.hi = lastTimelineView.hi;
  }
  const full = { lo, hi };        // 全库视野（无打开文档时的常规尺度）
  let anim = null;                // rAF 补间句柄（仅用于打开取景）
  const markers = document.createElement('div');
  markers.className = 'chrono-markers';
  wrap.appendChild(markers);
  const eras = document.createElement('div');   // 时代带（§3.2）：轴下 h10
  eras.className = 'chrono-eras';
  wrap.appendChild(eras);
  const flagEls = new Map();     // path -> 旗标元素（跨 layout 复用 → 位置/宽度随缩放平滑过渡）
  const spanEls = new Map();     // path -> 覆盖条元素

  /** 显示旗标的条目：带 &f ∪ 正在打开的文档（关闭即消失）∪ 强调过（拖入时间轴，保留）。 */
  function displayFlagOf(it) {
    if (it.flag) return it.flag;
    if (it.path === ctx.currentPath) return state.lang === 'zh-CN' ? '当前' : 'NOW';
    if (ctx.pins.has(it.path)) return state.lang === 'zh-CN' ? '强调' : 'PIN';
    return '';
  }

  const TICK_STEPS = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  function tickStep() {
    const width = wrap.clientWidth || 1200;
    const perYear = width / ((view.hi - view.lo) / YEAR);
    return TICK_STEPS.find((s) => s >= 90 / perYear) || 10000;
  }
  function x(ord) { return ((ord - view.lo) / (view.hi - view.lo)) * wrap.clientWidth; }

  function layout() {
    const width = wrap.clientWidth;
    if (!width) return;
    ticks.innerHTML = '';
    // 打开文档的起止时刻：与标尺刻度同款——轴下方一个年份（墨色、加粗区分）；顺带避免与常规刻度标签重叠
    markers.innerHTML = '';
    const cur = items.find((i) => i.path === ctx.currentPath);
    const markerPx = [];
    if (cur) {
      const put = (ord) => {
        if (ord == null) return;
        const px = x(ord);
        if (px < -40 || px > width + 40) return;
        markerPx.push(px);
        const tEl = document.createElement('span');
        tEl.className = 'tick chrono-marker-tick';
        tEl.style.left = px + 'px';
        const y = Math.round(ord / YEAR);
        tEl.textContent = y < 0 ? `前${Math.abs(y)}` : String(y);
        markers.appendChild(tEl);
      };
      put(cur.s);
      if (cur.e != null && cur.e > cur.s) put(cur.e);
    }
    const step = tickStep();
    const y0 = Math.floor((view.lo / YEAR) / step) * step;
    const y1 = Math.ceil((view.hi / YEAR) / step) * step;
    let guard = 0;
    for (let y = y0; y <= y1 && guard < 400; y += step, guard++) {
      const px = x(y * YEAR);
      if (px < -20 || px > width + 20) continue;
      if (markerPx.some((mp2) => Math.abs(mp2 - px) < 30)) continue;   // 让位起止标记
      const tEl = document.createElement('span');
      tEl.className = 'tick';
      tEl.style.left = px + 'px';
      tEl.textContent = y < 0 ? `前${Math.abs(y)}` : String(y);
      ticks.appendChild(tEl);
    }
    // 旗标布局：正常位置显示；重叠时「越晚图层越高」，较早的卡片依次向左让出 10px（时间位置不变）
    const flagItems = items.filter((i) => displayFlagOf(i)).sort((a, b) => a.s - b.s);
    for (let i = 0; i < flagItems.length; i++) {
      const it = flagItems[i];
      it._w = flagBaseW(it.title);
      it._trueX = x(it.s);
      it._left = it._trueX;
      it._z = 10 + i;               // 越晚（列表越靠后）图层越高
    }
    const chronoH = wrap.clientHeight || 112;
    const FLAG_H = 52;
    const COMPACT = chronoH < 84;                                            // 矮：只显示名字
    const maxLanes = Math.max(1, Math.floor((chronoH - 26 - FLAG_H) / (FLAG_H + 6)) + 1);   // 高：允许重叠卡片分道
    const chain = flagItems.filter((it) => it.path !== ctx.currentPath);   // 打开中的卡片恒在最上，不参与堆叠位移
    let lane = 0;
    for (let i = 0; i < chain.length; i++) {
      const it = chain[i];
      const prev = chain[i - 1];
      const overlaps = prev && it._trueX < prev._trueX + 10 + prev._w;       // 与前一张在真实位置附近重叠
      lane = overlaps ? (lane + 1) % maxLanes : 0;
      it._lane = lane;
      it._top = 10 + lane * (FLAG_H + 6);
    }
    for (let i = chain.length - 2; i >= 0; i--) {
      const cur = chain[i], nxt = chain[i + 1];
      if (nxt._left < cur._trueX + cur._w) cur._left = nxt._left - 10;   // 与后一张重叠 → 向左让出 10px 堆叠
    }
    for (const it of flagItems) {
      if (it._lane == null) { it._lane = 0; it._top = 10; }
      if (it.path === ctx.currentPath) { it._z = 80; it._top = 'axis'; }   // 打开中的卡片图层最上、紧贴轴线
    }

    // 覆盖条 + 旗标：**复用既有元素**（跨 layout 只改样式）→ 缩放/改高时位置与大小平滑过渡
    const shownSpans = new Set();
    for (const it of items) {
      const sx = x(it.s);
      const ex = it.e != null ? x(it.e) : sx;
      const w = Math.max(ex - sx, it.instant ? 0 : 6);
      let span = spanEls.get(it.path);
      if (!span) {
        span = document.createElement('div');
        span.dataset.path = it.path;
        spanEls.set(it.path, span);
        canvas.appendChild(span);
      }
      span.className = `span-bar${it.fuzzy ? ' fuzzy' : ''}${it.path === ctx.currentPath ? ' open' : ''}`;
      span.style.left = sx + 'px';
      span.style.width = w + 'px';
      span.title = `${it.title} · ${it.start}${it.end && !it.instant ? ' → ' + it.end : ''}`;
      shownSpans.add(it.path);
    }
    for (const [path0, el0] of [...spanEls]) if (!shownSpans.has(path0)) { el0.remove(); spanEls.delete(path0); }

    const shownFlags = new Set();
    for (const it of items) {
      const eyebrow = displayFlagOf(it);
      if (!eyebrow) continue;
      let flag = flagEls.get(it.path);
      if (!flag) {
        flag = document.createElement('button');
        flag.dataset.path = it.path;
        flagEls.set(it.path, flag);
        flag.addEventListener('click', () => {
          if (flag.__unpin) { flag.__unpin = false; return; }
          navigate(`#/w/${enc(ctx.worldId)}/${enc(it.path)}`);
        });
        flag.addEventListener('mouseenter', () => {
          spanEls.get(it.path)?.classList.add('show');
          flag.classList.add('expand');
          flag.style.zIndex = '90';                        // hover 提到最上
        });
        flag.addEventListener('mouseleave', () => {
          spanEls.get(it.path)?.classList.remove('show');
          flag.style.zIndex = flag.dataset.z || '10';
          if (it.path !== ctx.currentPath) flag.classList.remove('expand');
        });
        // 键盘 focus = hover 同款（§3.8）；Enter 由 button 原生触发 click
        flag.addEventListener('focus', () => {
          spanEls.get(it.path)?.classList.add('show');
          flag.classList.add('expand');
          flag.style.zIndex = '90';
        });
        flag.addEventListener('blur', () => {
          spanEls.get(it.path)?.classList.remove('show');
          flag.style.zIndex = flag.dataset.z || '10';
          if (it.path !== ctx.currentPath) flag.classList.remove('expand');
        });
        canvas.appendChild(flag);
      }
      const isHoverExpand = it.path === ctx.currentPath;
      flag.className = `event-flag${isHoverExpand ? ' open expand' : ''}${ctx.pins.has(it.path) ? ' pinned' : ''}${COMPACT ? ' compact' : ''}${!COMPACT && it._lane > 0 ? ' lane' : ''}`;
      flag.dataset.z = String(it._z);
      flag.style.left = it._left + 'px';
      if (it._top === 'axis') { flag.style.top = 'auto'; flag.style.bottom = '6px'; flag.classList.add('axis-anchored'); }
      else { flag.style.top = (it._top || 10) + 'px'; flag.style.bottom = 'auto'; flag.classList.remove('axis-anchored'); }
      flag.style.setProperty('--lead-x', (it._trueX - it._left + 10) + 'px');   // 引线始终垂在真实开始时刻
      flag.style.setProperty('--flag-w', it._w + 'px');   // 基础宽 = 最多 4 字（内容自然宽，hover 不跳变）
      if (!flag.classList.contains('expand')) flag.style.zIndex = String(it._z);
      if (flag.dataset.eyebrow !== eyebrow || flag.dataset.title !== it.title) {
        flag.dataset.eyebrow = eyebrow;
        flag.dataset.title = it.title;
        flag.innerHTML = `
          <span class="flag-eyebrow">${esc(eyebrow)}</span>
          <span class="flag-title">${esc(it.title)}</span>
          <span class="flag-date">${it.fuzzy ? '≈' : ''}${esc(it.start)}</span>${ctx.pins.has(it.path) ? `<span class="flag-unpin" title="${state.lang === 'zh-CN' ? '取消强调' : 'Unpin'}">${ICON.close}</span>` : ''}`;
        flag.querySelector('.flag-unpin')?.addEventListener('click', (e) => {
          e.stopPropagation();
          flag.__unpin = true;
          ctx.pins.delete(it.path);
          sessionStorage.setItem(`soliterra.pins.${ctx.worldId}`, JSON.stringify([...ctx.pins]));
          layout();
        });
      }
      shownFlags.add(it.path);
    }
    for (const [path0, el0] of [...flagEls]) if (!shownFlags.has(path0)) { el0.remove(); flagEls.delete(path0); }

    // 时代带（§3.2）：同 &a 条目的时间并集，bg/bg-soft 交替 + 名称；点击取景该时代；「更多设置」可关
    const eraOn = (ctx.settings?.axisEra ?? 'on') !== 'off';
    eras.style.display = eraOn ? '' : 'none';
    eras.innerHTML = '';
    const eraMap = new Map();
    for (const it of items) {
      if (!it.era) continue;
      const e2 = eraMap.get(it.era);
      if (e2) { e2.lo = Math.min(e2.lo, it.s); e2.hi = Math.max(e2.hi, it.e ?? it.s); }
      else eraMap.set(it.era, { era: it.era, lo: it.s, hi: it.e ?? it.s });
    }
    let eraIdx = 0;
    for (const e2 of [...eraMap.values()].sort((a, b) => a.lo - b.lo)) {
      const x1 = x(e2.lo), x2 = x(e2.hi);
      if (x2 < -60 || x1 > width + 60) { eraIdx++; continue; }
      const seg = document.createElement('button');
      seg.className = `era-band${eraIdx % 2 ? ' alt' : ''}`;
      seg.style.left = x1 + 'px';
      seg.style.width = Math.max(10, x2 - x1) + 'px';
      seg.title = e2.era;
      if (x2 - x1 > 72) seg.innerHTML = `<span class="era-name">${esc(e2.era)}</span>`;
      seg.addEventListener('pointerdown', (ev) => ev.stopPropagation());   // 不触发轴拖拽
      seg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const years = Math.max((e2.hi - e2.lo) / YEAR, 10);
        focusOrd((e2.lo + e2.hi) / 2, years);
      });
      eras.appendChild(seg);
      eraIdx++;
    }

    lastTimelineView = { world: ctx.worldId, lo: view.lo, hi: view.hi };
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

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      const d = (e.deltaY / wrap.clientWidth) * (view.hi - view.lo);
      view.lo += d; view.hi += d;
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
    view.lo = dragging.lo - d; view.hi = dragging.hi - d;
    layout();
  });
  const stop = () => { dragging = null; wrap.classList.remove('dragging'); };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);

  /** 取景（打开文档）：&s 落在屏幕 1/3、&e 落在屏幕 2/3（瞬时事件置于 1/3）。300ms。 */
  function focusPath(path) {
    const it = items.find((i) => i.path === path);
    if (!it) return;
    const s = it.s;
    const e = it.e != null && it.e > it.s ? it.e : null;
    const dur = e != null ? e - s : Math.max(YEAR, (full.hi - full.lo) * 0.02);
    animateTo(s - dur, (e ?? s) + dur, 300);
  }

  /** 旗标基础宽：按字数（最多 4 字；不足 4 字按实际字数收窄）。 */
  function flagBaseW(title) {
    return Math.min(title.length, 4) * 14 + 22;
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
  return { layout, focusPath, focusOrd, view };
}

// ============ 结构操作（§5.4 ②③④ + 重命名/删除）：右键菜单 ============
async function refreshTree(ctx) {
  worldDataCache.delete(ctx.worldId);
  ctx.tree = await api(`/api/w/${enc(ctx.worldId)}/tree`);
  worldDataCache.set(ctx.worldId, { tree: ctx.tree, timeline: ctx.timeline, ts: Date.now() });
  renderToc(ctx);
  refreshLintBadge(ctx);
}

function closeTreeMenu() { document.querySelectorAll('.tree-menu').forEach((m) => m.remove()); }

function showTreeMenu(e, ctx, node) {
  e.preventDefault();
  closeTreeMenu();
  const menu = document.createElement('div');
  menu.className = 'tree-menu';
  const hasMd = !!node.md;
  const inDir = node.dir || '';
  const items = [];
  if (inDir) items.push(['add', state.lang === 'zh-CN' ? '在此加条目' : 'Add entry here']);
  if (inDir && !hasMd) items.push(['child', state.lang === 'zh-CN' ? '在此加子条目' : 'Add child entry']);
  else if (inDir) items.push(['child', state.lang === 'zh-CN' ? '加子条目（建目录）' : 'Add child (with folder)']);
  if (hasMd) items.push(['rename', state.lang === 'zh-CN' ? '重命名' : 'Rename']);
  if (hasMd) items.push(['del', state.lang === 'zh-CN' ? '删除（移入回收站）' : 'Delete (trash)']);
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
      } else if (k === 'rename') {
        const cur = node.title || node.name;
        const nn = await askText(state.lang === 'zh-CN' ? '重命名为' : 'Rename to', cur);
        if (!nn || !nn.trim() || nn.trim() === cur) return;
        await api(`/api/w/${enc(ctx.worldId)}/fs/rename`, { method: 'POST', body: { path: node.md, newName: nn.trim() } });
        await after(state.lang === 'zh-CN' ? '已重命名' : 'Renamed');
        const baseDir = node.md.replace(/[^/]+$/, '');
        navigate(`#/w/${enc(ctx.worldId)}/${enc(baseDir + nn.trim() + '.md')}`);
      } else if (k === 'del') {
        // 两步确认（不弹原生 confirm）
        const label = node.title || node.name;
        const conf = await askText(state.lang === 'zh-CN' ? `删除「${label}」？输入「删除」确认（将移入回收站）` : `Type 删除 to confirm deleting ${label}`);
        if (conf !== '删除') { if (conf !== null) showToast(state.lang === 'zh-CN' ? '未确认，未删除' : 'Not confirmed', 'warning'); return; }
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
  const depthLimit = Math.max(1, parseInt(ctx.settings?.tocDepth || '1', 10) || 1);   // 默认展开深度（「更多设置」）

  // 生成节点行（返回元素）
  const buildRow = (node, depth) => {
    const row = document.createElement('div');
    row.className = 'toc-row';
    row.style.paddingLeft = 16 + depth * 16 + 'px';
    const isOpenable = !!node.md;
    row.classList.toggle('openable', isOpenable);
    // 视图分级（§15.3）：读者视图下受限条目行淡化（点击仍可开，打开时占位卡）
    if (node.restricted && ctx.settings?.view === 'reader') {
      row.classList.add('restricted');
      row.title = node.restricted === 'author' ? (state.lang === 'zh-CN' ? '仅作者可见' : 'Author only') : (state.lang === 'zh-CN' ? '秘传条目' : 'Sealed');
    }
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
      const expanded = depth < depthLimit || tocOpenDirs.has(node.dir) || containsCurrent(node);   // 默认深度 + 记忆手动展开 + 自动到当前
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
    e = await api(`/api/w/${enc(ctx.worldId)}/entry?path=${enc(path)}${ctx.viewOverride ? '&view=author' : ''}`);
  }
  catch (err) { reader.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`; return; }
  // 视图分级（§15.3）：读者视图下 &v 作者 → 受限卡；&v 秘传 → 揭示卡；按钮以作者视图重取
  if (e.restricted || e.sealed) {
    const isAuthor = e.restricted === 'author';
    reader.innerHTML = `
      <article class="entry">
        <div class="entry-title-row"><h1 class="entry-title">${esc(e.title)}</h1></div>
        <div class="view-gate">
          <span class="eyebrow">${isAuthor ? (state.lang === 'zh-CN' ? '仅作者可见' : 'Author only') : (state.lang === 'zh-CN' ? '秘传条目' : 'Sealed')}</span>
          <p>${isAuthor
            ? (state.lang === 'zh-CN' ? '读者视图下，&v 作者 条目的正文不显示、不下发。' : 'In reader view, &v 作者 entries are not shown.')
            : (state.lang === 'zh-CN' ? '读者视图下，&v 秘传 的条目默认隐藏，点击揭示。' : 'In reader view, &v 秘传 entries are sealed; click to reveal.')}</p>
          <button class="button-primary" id="view-reveal">${isAuthor ? (state.lang === 'zh-CN' ? '以作者视图显示' : 'Show as author') : (state.lang === 'zh-CN' ? '揭示' : 'Reveal')}</button>
        </div>
      </article>`;
    reader.querySelector('#view-reveal').addEventListener('click', async () => {
      ctx.viewOverride = true;
      await openEntry(ctx, path, chrono);
      ctx.viewOverride = false;
    });
    if (chrono && !ctx.skipFrame) chrono.focusPath(path);
    if (chrono) chrono.layout();
    if (ctx.tree && !ctx.panelPainted) updateTocCurrent(ctx, path);
    ctx.panelPainted = false;
    ctx.lastTocTop = (path || '').split('/')[0];
    document.querySelectorAll('.rlf-card').forEach((c) => c.classList.toggle('open', c.dataset.path === path));
    return;
  }

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

  if (chrono && !ctx.skipFrame) chrono.focusPath(path);
  if (chrono) chrono.layout();
  // 目录：换书 → 重建树；同书 → 只移动高亮行（不重建，避免面板闪动）
  const topOf2 = (p2) => (p2 || '').split('/')[0];
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
    const saveD = debounce(() => autoSave(ctx), 500);
    const drawerD = debounce(() => renderMetaDrawer(ctx), 300);
    ctx.editor = {
      getValue: () => ta.value,
      setValue: (t) => { ta.value = t; ta.dispatchEvent(new Event('input')); },
      insertMetaLine: (k) => { ta.value = insertMetaIntoText(ta.value, k); ta.dispatchEvent(new Event('input')); ta.focus(); },
      destroy: () => ta.remove(),
    };
    ta.addEventListener('input', () => { saveD(); drawerD(); });
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
  const saveD = debounce(() => autoSave(ctx), 500);
  const drawerD = debounce(() => renderMetaDrawer(ctx), 300);       // 抽屉重扫（§B.2 文档改动 300ms）
  ctx.editor = window.SoliterraEditor.create(document.getElementById('editor-host'), {
    doc: text,
    onChange: (t) => { saveD(t); drawerD(t); },
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

/** 防抖自动保存（不提交，静默）。 */
async function autoSave(ctx) {
  if (!ctx.editing || !ctx.editor) return;
  await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: ctx.currentPath, text: ctx.editor.getValue() } }).catch(() => {});
}

async function saveEdit(ctx) {
  if (!ctx.editor) return;
  await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: ctx.currentPath, text: ctx.editor.getValue() } });
}

async function exitEdit(ctx) {
  // 退出并保存（不提交——改动累计为未提交，提交在 + 面板）
  await saveEdit(ctx);
  worldDataCache.delete(ctx.worldId);
  refreshLintBadge(ctx);
  ctx.editing = false;
  if (ctx.editor) { try { ctx.editor.destroy(); } catch {} ctx.editor = null; }
  setEditFab(ctx, false);
  ctx.skipFrame = true;                    // 原地恢复阅读：不取景
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
function renderTools(ctx) {
  const modal = document.getElementById('tools-host');
  if (!modal) return;
  modal.innerHTML = `
      <div class="tools-layout">
        <nav class="tools-nav">
          <button class="filter-button is-active" data-tool="lint"><span>${lt('lintTitle')}</span></button>
          <button class="filter-button" data-tool="date"><span>${lt('toolDate')}</span></button>
          <button class="filter-button" data-tool="brackets"><span>${lt('toolBrackets')}</span></button>
          <button class="filter-button" data-tool="drift"><span>${lt('toolDrift')}</span></button>
          <button class="filter-button" data-tool="images"><span>${lt('toolImages')}</span></button>
          <button class="filter-button" data-tool="regex"><span>${lt('toolRegex')}</span></button>
          <button class="filter-button" data-tool="dup"><span>${lt('toolDup')}</span></button>
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
      refreshLintBadge(ctx);
      showToast(`${lt('toolApplied')} ${r.changed} ${lt('toolPlaces')} · backup: ${r.backup}`, 'success');
      runScan(currentTool);
      // 刷新当前阅读内容（若被修改）——原地重载，不动面板
      if (chosen.some((x) => x.path === ctx.currentPath)) {
        ctx.skipFrame = true;
        await openEntry(ctx, ctx.currentPath, ctx.chrono);
      }
    } catch (e) {
      showToast(String(e.message), 'error');
      applyBtn.disabled = false;
    }
  });

  runScan('lint');
}

// ============ 通用滚动指示条（替代原生滚动条：内容区顶部横向百分比条） ============
export function attachScrollIndicators(root) {
  const zones = (root || document).querySelectorAll(
    '.reader-column, .panel-scroll, .tools-list, .search-results, .modal-scroll, .editor-shell'
  );
  zones.forEach((zone) => {
    if (zone.dataset.sbar) return;
    zone.dataset.sbar = '1';
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
      const ratio = vh / ch;
      const max = ch - vh;
      span.style.width = (ratio * 100) + '%';
      span.style.left = ((zone.scrollTop / max) * (100 - ratio * 100)) + '%';
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
    ctx.skipFrame = true;                  // 原地重载正文：不取景、不重建面板
    await openEntry(ctx, ctx.currentPath, ctx.chrono);
  } catch (err) { showToast(String(err.message), 'error'); }
}
