// Soliterra 共享 UI 原语（第 92 轮拆分）：转义/序数/图标/短语/Toast/纸面/勾选/滚动条——世界与首页共用。
import { state } from './app.js';
import { YEAR } from './timeline-layout.js';

export function parseOrd(text) {
  if (!text) return null;
  const m = String(text).match(/^(-?)(\d{1,4})\.(\d{1,2}|\*)\.(\d{1,2}|\*)$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const y = parseInt(m[2], 10) * sign;
  const mo = m[3] === '*' ? 6 : parseInt(m[3], 10);
  const d = m[4] === '*' ? 15 : parseInt(m[4], 10);
  return y * YEAR + (mo - 1) * 30.44 + (d - 1);
}
export function enc(s) { return encodeURIComponent(s); }
export function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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
  loc: { 'zh-CN': '位置', en: 'Location' },
  dashJump: { 'zh-CN': '时间轴取景到', en: 'Jump timeline to' },
  dashLater: { 'zh-CN': '加入稍后阅读', en: 'Read later' },
  dashTools: { 'zh-CN': '打开工具箱', en: 'Open toolbox' },
  exDocMd: { 'zh-CN': '文档 md', en: 'Doc md' },
  exDocTxt: { 'zh-CN': '文档 txt', en: 'Doc txt' },
  exBookMd: { 'zh-CN': '本书 md', en: 'Book md' },
  exBookEpub: { 'zh-CN': '本书 EPUB', en: 'Book EPUB' },
  exBookPdf: { 'zh-CN': '本书 PDF', en: 'Book PDF' },
  exBookDocx: { 'zh-CN': '本书 DOCX', en: 'Book DOCX' },
  exSite: { 'zh-CN': '只读站点', en: 'Site' },
  exSiteOpen: { 'zh-CN': '上次站点 ↗', en: 'Last site ↗' },
  siteBuilt: { 'zh-CN': '站点已生成：', en: 'Site built: ' },
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
  toolOnboard: { 'zh-CN': '时间上手（按时间线提取 &s）', en: 'Onboard dates from timeline' },
  toolStructure: { 'zh-CN': '结构规范化（世界根 → books/）', en: 'Normalize structure (→ books/)' },
  toolBrackets: { 'zh-CN': '【【】】 → [[ ]]', en: '【【】】 → [[ ]]' },
  toolSymbols: { 'zh-CN': '符号规范化（全角→英文）', en: 'Symbols (fullwidth → ASCII)' },
  toolScanning: { 'zh-CN': '扫描中…', en: 'Scanning…' },
  toolNoIssues: { 'zh-CN': '没有需要修复的内容', en: 'Nothing to fix' },
  toolApply: { 'zh-CN': '应用选中', en: 'Apply selected' },
  toolApplied: { 'zh-CN': '已修复', en: 'Fixed' },
  toolPlaces: { 'zh-CN': '处', en: 'places' },
  language: { 'zh-CN': '语言 Language', en: 'Language' },
  about: { 'zh-CN': '关于', en: 'About' },
};
export function lt(key) { return L[key][state.lang] || L[key].en; }

export const ICON = {
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

/** 极简纸面（与 askDialog 同族；openPaperDialog 已被面板方案取代，此处轻量实现）。 */
export function openPaperDialog2(title) {
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

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
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
export function checkHTML(checked, label, attrs = '') {
  return `<label class="check-row${checked ? ' on' : ''}" ${attrs}><span class="check-box"></span><span class="check-label">${label}</span></label>`;
}
export function bindChecks(scope) {
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
export function showToast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}


/** 平台样式化确认弹层（第 92 轮：保存冲突等需要明确二选一的场合；替代原生 confirm）。 */
export function confirmModal(title, bodyText, okLabel, cancelLabel) {
  const zh = state.lang === 'zh-CN';
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog ask-dialog">
        <div class="modal-header"><span class="eyebrow">${esc(title)}</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-scroll">
          <p class="meta-explain">${esc(bodyText)}</p>
          <div class="modal-actions">
            <button class="button-ghost" data-close>${esc(cancelLabel || (zh ? '取消' : 'Cancel'))}</button>
            <button class="button-primary" data-ok>${esc(okLabel || (zh ? '确定' : 'OK'))}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const done = (v) => { modal.remove(); resolve(v); };
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => done(false)));
    modal.querySelector('[data-ok]').addEventListener('click', () => done(true));
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
  });
}
