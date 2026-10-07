// Soliterra ⌘K 搜索与动作（第 105 轮拆分自 world.js）：全文检索 / 日期取景 / 动作行 /
// 仪表盘 / 地图占位。依赖经 hooks.setPanel 回调面板原语（避免 import 环）。
import { api, t, state, navigate } from './app.js';
import { enc, esc, showToast, lt, openPaperDialog2, parseOrd } from './ui.js';
import { hooks, topBookNodes, currentBookOf, refreshGitStatus } from './world-core.js';
import { addReadlater } from './world-readlater.js';
import { refreshTree } from './world-tree.js';

// ============ ⌘K 搜索 ============
export function openSearch(ctx) {
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
      <span class="entry-card-title">＋ ${t('search.newEntry')} · ${esc(q.trim())}</span></button>`);
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
      else showToast(t('search.notFound').replace('{n}', target), 'warning');
    } else if (act === 'newentry') {
      const name = b.dataset.q;
      const book = currentBookOf(ctx);
      if (!book?.dir) { showToast(t('search.openBookFirst'), 'warning'); return; }
      try {
        const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: book.dir, name, pair: false } });
        await refreshTree(ctx);
        refreshGitStatus(ctx);
        if (r2.path) navigate(`#/w/${enc(ctx.worldId)}/${enc(r2.path)}`);
        showToast(t('search.created').replace('{n}', name), 'success');
      } catch (e2) { showToast(String(e2.message), 'error'); }
    } else if (act === 'tools') {
      hooks.setPanel?.(ctx, ctx.panel === 'tools' ? '' : 'tools');
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
      <div class="eyebrow">${t('map.soon')}</div>
      <p>${state.lang === 'zh-CN'
        ? '接入契约已备：外部编辑器导出 assets/maps/*.png + hotspots.json（热区 → 条目）；或以 iframe 嵌入（?world=&pin=）回传热区参数。'
        : 'Contract ready: external editor exports assets/maps/*.png + hotspots.json (hotspots → entries), or iframe embed (?world=&pin=).'}</p>
    </div>`;
}

export async function openDashboard(ctx) {
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
        <div class="dash-card"><span class="eyebrow">${t('dash.links')}</span><b>${d.links}</b><small>${d.entries ? (d.links / d.entries).toFixed(2) : '0'} ${t('dash.linksUnit')}</small></div>
        <div class="dash-card"><span class="eyebrow">${t('dash.depth')}</span><b>${d.maxDepth}</b></div>
        <div class="dash-card"><span class="eyebrow">${t('dash.dangling')}</span><b class="${d.dangling ? 'warn' : ''}">${d.dangling}</b></div>
        <div class="dash-card"><span class="eyebrow">${t('dash.isolated')}</span><b class="${d.isolated ? 'warn' : ''}">${d.isolated}</b></div>
        <div class="dash-card"><span class="eyebrow">${t('dash.commits7')}</span><b>${d.commitsWeek}</b></div>
        <div class="dash-card"><span class="eyebrow">${t('dash.span')}</span><b class="dash-span">${esc(span)}</b></div>
      </div>
      <div class="dash-tags"><span class="eyebrow">${t('dash.tagsTop')}</span>
        ${d.tags.length ? d.tags.map((t2) => `<span class="dash-tag"><i style="width:${Math.round((t2.n / d.tags[0].n) * 100)}%"></i><em>${esc(t2.t)}</em><b>${t2.n}</b></span>`).join('') : '—'}
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">${esc(String(e.message))}</div>`;
  }
}

