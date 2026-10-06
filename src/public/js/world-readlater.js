// Soliterra 稍后阅读（底部中央卡片集：rest = 扇形聚拢；hover = 横排展开；单卡 hover 上升；第 92 轮拆分）。
import { api, state, navigate } from './app.js';
import { enc, esc, ICON, showToast } from './ui.js';

// ============ 稍后阅读（底部中央卡片集：rest = 扇形聚拢；hover = 横排展开；单卡 hover 上升） ============
const FAN = { w: 108, h: 140, show: 70, rise: 28, gap: 8, restPitch: 26, minPitch: 22 };

export function renderReadlater(ctx) {
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

export async function addReadlater(ctx, path) {
  const title = path.split('/').pop().replace(/\.md$/i, '');
  ctx.readlater = await api(`/api/w/${enc(ctx.worldId)}/readlater`, {
    method: 'POST', body: { action: 'add', item: { path, title } },
  });
  ctx.rlfPulse = path;
  renderReadlater(ctx);
  showToast(state.lang === 'zh-CN' ? '已加入稍后阅读' : 'Added to read later', 'success');
}

