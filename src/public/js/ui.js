// Soliterra 共享 UI 原语（第 92 轮拆分）：转义/序数/图标/短语/Toast/纸面/勾选/滚动条——世界与首页共用。
import { api, state, t } from './app.js';
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
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }   /* 第 105 轮：补单引号——消除「单引号属性位」整类注入 */


export function lt(key) { return t(key); }   /* 第 105 轮：L 表并入 locales（单轨 t() 链） */

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
            <button class="button-ghost" data-close>${t('ui.cancel')}</button>
            <button class="button-primary" data-ok>${t('ui.ok')}</button>
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

// 极简 toast（docs/design.md 四语义色：3px 前缘 + 等宽标签）
export function showToast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}


/** 平台样式化确认弹层（第 92 轮：保存冲突等需要明确二选一的场合；替代原生 confirm）。 */
export function confirmModal(title, bodyText, okLabel, cancelLabel) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog ask-dialog">
        <div class="modal-header"><span class="eyebrow">${esc(title)}</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-scroll">
          <p class="meta-explain">${esc(bodyText)}</p>
          <div class="modal-actions">
            <button class="button-ghost" data-close>${esc(cancelLabel || t('ui.cancel'))}</button>
            <button class="button-primary" data-ok>${esc(okLabel || t('ui.ok'))}</button>
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

// ---------- 图片管线共享件（第 115 轮自 world.js 迁入：详情面板/编辑器/首页冷启动均可用） ----------

// ============ 图片管线（§B.5）：上传 / 选择器 / 大图纸面 ============
/** 上传图片文件 → assets/imported/（重名加序号）；返回相对路径。 */
export async function uploadAsset(ctx, file) {
  const r = await fetch(`/api/w/${enc(ctx.worldId)}/asset?name=${enc(file.name || 'image.png')}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `上传失败（${r.status}）`);
  showToast(t('img.uploaded').replace('{n}', data.path), 'success');
  return data.path;
}

/** assets 图片选择纸面：缩略图网格 + 过滤 + 上传；点选返回 {path, alt}，关闭返回 null。 */
export function openAssetPicker(ctx) {
  return new Promise((resolve) => {
    const { close, body } = openPaperDialog2('▣ ' + t('img.insert'));
    body.innerHTML = `
      <div class="asset-picker">
        <div class="asset-bar">
          <input class="text-input" id="asset-filter" placeholder="${t('img.filter')}">
          <label class="button-ghost asset-upload" for="asset-file">${t('img.upload')}</label>
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
        </button>`).join('') : `<div class="empty-state">${t('img.none')}</div>`;
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
