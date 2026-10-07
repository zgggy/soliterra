// Soliterra 详情面板（第 92 轮）：世界（首页卡片右键/⋯ 菜单）与书（目录树/书卡右键）的图形化管理。
// 封面单点真相 = &m：世界封面住 README.md，书封面住 <名>.md——面板改的是这一行，不是另立存储。
import { api, state, bindCoverFallbacks, t } from './app.js';
import { enc, esc, showToast, openPaperDialog2 } from './ui.js';
import { hooks, firstEntryOf, flattenTree } from './world-core.js';
import { refreshTree } from './world-tree.js';

/** 选本机图片 → 复制进 assets/covers/ → 写目标条目 &m（系统对话框；浏览器拿不到本地路径）。 */
async function pickCover(worldId, entryRel, { writeMeta = true } = {}) {
  const pick = await api('/api/pick/file', { method: 'POST', body: {} });
  if (!pick.ok) return null;   // 用户取消
  const r = await api(`/api/w/${enc(worldId)}/cover`, { method: 'POST', body: { path: entryRel, image: pick.path, writeMeta } });
  return r.cover;
}

/** 封面大图（点击即换）；返回 { el, refresh(rpath) }。 */
function coverBlock(worldId, coverRel, glyph, entryRel, onSet) {
  const zh = state.lang === 'zh-CN';
  const btn = document.createElement('button');
  btn.className = 'detail-cover';
  btn.title = t('detail.coverHint');
  const paint = (r) => {
    btn.innerHTML = r
      ? `<img src="/w/${enc(worldId)}/${enc(r)}?t=${Date.now()}" alt="">`
      : `<span class="detail-cover-glyph">${esc(glyph)}</span><span class="detail-cover-hint eyebrow">${t('detail.coverSet')}</span>`;
    bindCoverFallbacks(btn);
  };
  paint(coverRel);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await pickCover(worldId, entryRel);
      if (r) { paint(r); onSet?.(r); showToast(t('detail.coverUpdated'), 'success'); }
    } catch (e) { showToast(String(e.message), 'error'); }
    btn.disabled = false;
  });
  return btn;
}

/** 世界详情（首页：卡片右键 / ⋯ 菜单「详情」）。onChanged = 封面变化后由首页刷新卡片。 */
export async function openWorldDetail(w, onChanged) {
  const zh = state.lang === 'zh-CN';
  const rootRel = w.rootRel || 'README.md';
  const { body } = openPaperDialog2(t('detail.worldTitle').replace('{n}', w.name));
  const [git, meta] = await Promise.all([
    api(`/api/w/${enc(w.id)}/git`).catch(() => ({ ok: false })),
    api('/api/meta').catch(() => ({ home: '' })),
  ]);
  const dirShow = w.dir ? (meta.home && w.dir.startsWith(meta.home + '/') ? '~' + w.dir.slice(meta.home.length) : w.dir) : '';
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-cover-col" id="wd-cover"></div>
      <div class="detail-info">
        <h2 class="detail-name">${esc(w.name)}</h2>
        <p class="detail-sub">${esc(w.subtitle || '')}</p>
        <div class="detail-rows">
          <div class="set-row"><span class="eyebrow">${t('detail.statEntries')}</span><b>${w.stats.entries}</b></div>
          <div class="set-row"><span class="eyebrow">${t('detail.statEvents')}</span><b>${w.stats.events}</b></div>
          <div class="set-row"><span class="eyebrow">${t('detail.statLinks')}</span><b>${w.stats.links}</b></div>
          <div class="set-row"><span class="eyebrow">${git}</span><span class="wp-git">${git.ok ? `${esc(git.branch)} · ${esc(git.hash)} · ${esc(git.when)}` : (t('detail.notRepo'))}</span></div>
          ${dirShow ? `<div class="set-row"><span class="eyebrow">${t('detail.location')}</span><span class="wz-path" title="${esc(w.dir)}">${esc(dirShow)}/</span></div>` : ''}
          <div class="set-row"><span class="eyebrow">${t('detail.coverMeta')}</span><span class="detail-meta-path">&m ${esc(w.cover || '—')} @ ${esc(rootRel)}</span></div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="button-ghost" data-act="reveal">${t('detail.reveal')}</button>
      <button class="button-primary" data-act="open">${t('detail.openWorld')}</button>
    </div>`;
  const coverEl = coverBlock(w.id, w.cover, w.name.slice(0, 1), rootRel, () => onChanged?.());
  body.querySelector('#wd-cover').appendChild(coverEl);
  body.querySelector('[data-act="reveal"]').addEventListener('click', async () => {
    try { await api('/api/worlds/reveal', { method: 'POST', body: { id: w.id } }); }
    catch (e) { showToast(String(e.message), 'error'); }
  });
  body.querySelector('[data-act="open"]').addEventListener('click', () => {
    body.closest('.reader-modal').remove();
    location.hash = `#/w/${encodeURIComponent(w.id)}`;
  });
}

/** 书籍详情（世界内：树行/书卡右键「书籍详情」）。封面 = &m @ <名>.md；展示结构与时间覆盖。 */
export async function openBookDetail(ctx, node) {
  const zh = state.lang === 'zh-CN';
  if (!node?.md) { showToast(t('detail.pairFirst'), 'warning'); return; }
  const { body, close } = openPaperDialog2(t('detail.bookTitle').replace('{n}', node.title || node.name));
  let e;
  try { e = await api(`/api/w/${enc(ctx.worldId)}/entry?path=${enc(node.md)}`); }
  catch (err) { showToast(String(err.message), 'error'); close(); return; }
  const lead = String(e.body || '').replace(/^#.*$/m, '').trim().split(/\n\s*\n/)[0] || '';
  const children = flattenTree(node).length - (node.md ? 1 : 0);
  const timed = ctx.timeline.filter((r) => r.path === node.md || r.path.startsWith(node.dir + '/')).length;
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-cover-col" id="bd-cover"></div>
      <div class="detail-info">
        <h2 class="detail-name">${esc(node.title || node.name)}</h2>
        <p class="detail-sub">${esc(lead.slice(0, 120))}</p>
        <div class="detail-rows">
          <div class="set-row"><span class="eyebrow">${t('detail.tags')}</span><span>${esc((node.tags || []).join(' · ') || '—')}</span></div>
          <div class="set-row"><span class="eyebrow">${t('detail.entryCount')}</span><b>${children}</b></div>
          <div class="set-row"><span class="eyebrow">${t('detail.timed')}</span><b>${timed}</b></div>
          <div class="set-row"><span class="eyebrow">${t('detail.path')}</span><span class="wz-path">${esc(node.md)}</span></div>
          <div class="set-row"><span class="eyebrow">${t('detail.coverMeta')}</span><span class="detail-meta-path">&m ${esc(node.cover || '—')} @ ${esc(node.md)}</span></div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="button-ghost" data-act="open">${t('detail.openBook')}</button>
      <button class="button-ghost" data-act="close">${t('detail.close')}</button>
    </div>`;
  const coverEl = coverBlock(ctx.worldId, node.cover, (node.title || node.name).slice(0, 1), node.md, () => refreshTree(ctx));
  body.querySelector('#bd-cover').appendChild(coverEl);
  body.querySelector('[data-act="open"]').addEventListener('click', () => {
    const first = firstEntryOf(node);
    if (first) location.hash = `#/w/${enc(ctx.worldId)}/${enc(first)}`;
    close();
  });
  body.querySelector('[data-act="close"]').addEventListener('click', close);
}

// 注册进 hooks（world-tree / home 经此调用——避免相互 import 环）
hooks.openWorldDetail = openWorldDetail;
hooks.openBookDetail = openBookDetail;
