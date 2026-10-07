// 链接悬浮预览卡（功能设计 §6）——正文双链与关系图节点共用。
// 360×336；封面 blur 遮罩；标题/简介/前100字；「稍后阅读」按钮条 = 卡高 1/8（42px）；
// 默认在锚点上方，越界翻下；卡在上→按钮在下，卡在下→按钮在上（按钮永远贴锚点一侧）。

import { api, state, t } from './app.js';
import { esc } from './ui.js';

const W = 360, H = 336, BTN = 42;
const cache = new Map();
let cardEl = null, timer = null, hideTimer = null, activeAnchor = null;

async function fetchPreview(ctx, path) {
  const key = `${ctx.worldId}:${path}`;
  if (cache.has(key)) return cache.get(key);
  const e = await api(`/api/w/${encodeURIComponent(ctx.worldId)}/entry?path=${encodeURIComponent(path)}`);
  const body = (e.body || '').replace(/^#.*$/m, '').replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/[*_`#>]/g, '').trim();
  const lead = body.split(/\n\s*\n/).map((x) => x.trim()).find(Boolean) || '';
  const data = {
    path, title: e.title,
    subtitle: lead.slice(0, 48),
    excerpt: body.replace(/\s+/g, ' ').slice(0, 100),
    cover: e.meta?.m?.[0] || null,
    q: e.meta?.q?.[0] || null,   // 方向 C：可靠性徽章前置
    p: e.meta?.p?.[0] || null,
  };
  cache.set(key, data);
  return data;
}

function ensureCard() {
  if (cardEl) return cardEl;
  cardEl = document.createElement('div');
  cardEl.className = 'link-preview-card';
  cardEl.hidden = true;
  cardEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  cardEl.addEventListener('mouseleave', () => schedulehide());
  document.body.appendChild(cardEl);
  window.addEventListener('scroll', hideCard, true);
  return cardEl;
}

export function hideCard() {
  clearTimeout(timer); clearTimeout(hideTimer);
  activeAnchor = null;
  if (cardEl) { cardEl.hidden = true; cardEl.innerHTML = ''; }
}
function schedulehide() { clearTimeout(hideTimer); hideTimer = setTimeout(hideCard, 120); }

/** 指针离开锚点（链接/节点）——120ms 宽限，期间进卡则保持。 */
export function leaveAnchor() { activeAnchor = null; schedulehide(); }

/** 卡片定位（锚点上方优先，越界翻下；按钮永远贴锚点一侧）——普通卡与缺条目卡共用。 */
function placeCard(card, rect) {
  const above = rect.top - H - 8 >= 8;
  const below = rect.bottom + 8 + H <= window.innerHeight - 8;
  const placeAbove = above || !below;
  const top = placeAbove ? Math.max(8, rect.top - H - 8)
    : Math.min(window.innerHeight - H - 8, rect.bottom + 8);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - W / 2), window.innerWidth - W - 12);
  const btnSide = placeAbove ? 'bottom' : 'top';
  card.style.top = top + 'px';
  card.style.left = left + 'px';
  card.className = `link-preview-card btn-${btnSide}`;
  return btnSide;
}

/** 缺条目卡（第 91 轮）：双链指向尚不存在的条目 → 展示目标名 + 「创建文件」按钮
 *  （替代既有条目卡的「稍后阅读」）。创建 = 世界根目录下生成 `<目标>.md`（ctx.onCreateMissing）。 */
function paintMissing(ctx, target, rect) {
  const zh = state.lang === 'zh-CN';
  const card = ensureCard();
  const btnSide = placeCard(card, rect);
  card.style.backgroundImage = 'none';
  card.classList.add('no-cover', 'is-missing');
  card.innerHTML = `
    <div class="lpc-scrim"></div>
    <div class="lpc-body">
      <div class="lpc-title">${esc(target)}</div>
      <div class="lpc-sub">${t('lpc.notCreated')}</div>
      <div class="lpc-hairline"></div>
      <div class="lpc-excerpt">${zh
        ? '双链指向的条目还不存在——可在这里一键建立文件（生成在世界根目录），把考据缺口变成待写清单。'
        : 'This link points to an entry that does not exist yet — create it at the world root and turn the gap into a to-write list.'}</div>
    </div>
    <button class="lpc-later lpc-create">＋ ${t('lpc.create')}</button>`;
  card.querySelector('.lpc-create').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t('lpc.creating');
    try {
      await ctx.onCreateMissing?.(target);
      hideCard();
    } catch {
      btn.disabled = false;
      btn.textContent = `＋ ${t('lpc.create')}`;
    }
  });
  card.hidden = false;
  card.classList.remove('lpc-in');
  void card.offsetWidth;
  card.classList.add('lpc-in');
}

/**
 * 显示预览卡（带 220ms 触发延迟）。
 * @param ctx {worldId, readlater, onAddLater, onCreateMissing}
 * @param path 条目路径（opts.missing 时为双链目标名）
 * @param rect 锚点矩形（链接或图节点）
 * @param delay 触发延迟 ms（默认 220）
 * @param opts {refuted, missing} missing=目标名 → 缺条目卡（创建文件按钮）
 */
export function showLinkCard(ctx, path, rect, delay = 220, opts = {}) {
  clearTimeout(timer); clearTimeout(hideTimer);
  activeAnchor = rect;
  timer = setTimeout(async () => {
    if (opts.missing) { if (activeAnchor === rect) paintMissing(ctx, opts.missing, rect); return; }
    let data;
    try { data = await fetchPreview(ctx, path); }
    catch { return; }
    if (activeAnchor !== rect) return; // 期间已移开
    const card = ensureCard();

    const already = (ctx.readlater || []).some((x) => x.path === path);
    const btnSide = placeCard(card, rect);
    card.style.backgroundImage = data.cover
      ? `url("/w/${encodeURIComponent(ctx.worldId)}/${encodeURIComponent(data.cover)}")`
      : 'none';
    if (!data.cover) card.classList.add('no-cover');
    const refutedBlock = opts.refuted
      ? `<div class="lpc-refuted"><span class="lpc-refuted-tag">${t('lpc.refuted')}</span><div class="lpc-refuted-text">${t('lpc.refutedText')}</div></div>`
      : '';
    const P_ZH = { canon: '正典', draft: '草稿', disputed: '存疑', deprecated: '废弃' };
    const qCls = data.q === '已证伪' ? 'q-err' : (data.q === '可靠' ? 'q-ok' : 'q-warn');
    const pCls = data.p === 'canon' ? 'q-ok' : (data.p === 'disputed' ? 'q-err' : 'q-warn');
    const badges = (data.q || data.p)
      ? `<div class="lpc-badges">${data.q ? `<span class="lpc-rbadge ${qCls}">可靠度 · ${esc(data.q)}</span>` : ''}${data.p ? `<span class="lpc-rbadge ${pCls}">状态 · ${esc(P_ZH[data.p] || data.p)}</span>` : ''}</div>`
      : '';
    card.innerHTML = `
      <div class="lpc-scrim"></div>
      <div class="lpc-body">
        ${refutedBlock}
        ${badges}
        <div class="lpc-title">${esc(data.title)}</div>
        <div class="lpc-sub">${esc(data.subtitle)}</div>
        <div class="lpc-hairline"></div>
        <div class="lpc-excerpt">${esc(data.excerpt)}…</div>
      </div>
      <button class="lpc-later${already ? ' added' : ''}">${already ? t('lpc.added') : '⏱ ' + t('lpc.readLater')}</button>`;
    const btn = card.querySelector('.lpc-later');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.classList.contains('added')) return;
      try { if (ctx.onAddLater) await ctx.onAddLater(path); } catch { return; }
      btn.classList.add('added');
      btn.textContent = t('lpc.added');
    });
    card.hidden = false;
    card.classList.remove('lpc-in');
    void card.offsetWidth;             // 强制重排 → 每次打开都重启 140ms 淡入 + 4px 上浮（§6.1）
    card.classList.add('lpc-in');
  }, delay);
}
