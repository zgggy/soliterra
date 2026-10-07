// 卡片拖拽统一原语（第 117 轮）：世界卡 / 书卡共用一套机制——
// 按下阈值 5px 激活 → 紧凑名字幽灵（into 区带「目标/原名」前缀）→ 横向分区
//（两区 = 插前/插后；三区 = 插前/移入目标/插后）→ 间隙线标记 → 松手 400ms 点击守卫。
import { armClickGuard } from './world-core.js';
import { esc } from './ui.js';

export function createCardDragger({
  cardSel,                 // 落点卡片选择器（closest 命中域，如 '.book-card'）
  zones = ['before', 'after'],   // 分区语义；含 'into' = 三分区（1/3 切分），否则二分
  gapLineParent = null,    // () => 挂间隙线的容器；null/返回 null = 不画线
  validTarget = null,      // (src, target) => 是否可落（默认任何同类卡）
  onDrop,                  // async ({ mode, src, target, meta }) 松手提交
} = {}) {
  let drag = null;
  let bound = false;
  let line = null;

  const clearMarks = (scope) => scope
    ?.querySelectorAll('.drop-sibling, .drop-after, .drop-into')
    .forEach((n) => n.classList.remove('drop-sibling', 'drop-after', 'drop-into'));

  const ensureLine = () => {
    const parent = gapLineParent?.();
    if (!parent) return null;
    if (!line || !line.isConnected || line.parentElement !== parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      line = document.createElement('div');
      line.className = 'card-drop-line';
      parent.appendChild(line);
    }
    return line;
  };
  const hideLine = () => { if (line) line.style.display = 'none'; };
  /** 间隙线 = 独立 2px 竖线，悬在两卡间隙正中（含容器自身滚动偏移）。 */
  const showLine = (target, after) => {
    const ln = ensureLine();
    if (!ln) return;
    const parent = ln.parentElement;
    const cs = getComputedStyle(parent);
    const gap = parseFloat(cs.columnGap || cs.gap) || 14;
    const r = target.getBoundingClientRect(), pr = parent.getBoundingClientRect();
    const sl = parent.scrollLeft || 0, st = parent.scrollTop || 0;
    ln.style.display = 'block';
    ln.style.top = (r.top - pr.top + st) + 'px';
    ln.style.height = r.height + 'px';
    ln.style.left = (after
      ? r.right - pr.left + sl + gap / 2 - 1
      : r.left - pr.left + sl - gap / 2 - 1) + 'px';
  };

  const ghostName = (card) => card.querySelector('.card-title')?.textContent?.trim()
    || card.dataset.name || '';

  const activate = () => {
    drag.active = true;
    document.body.classList.add('toc-dragging');
    drag.card.style.transform = '';   // 冻结 hover 倾斜，防 ghost/源卡歪着拖
    drag.card.classList.add('dragging-src');   // 源卡原地淡出（占位保持网格/行不跳）
    const ghost = document.createElement('div');
    ghost.className = 'toc-drag-ghost';
    ghost.textContent = ghostName(drag.card);
    document.body.appendChild(ghost);
    drag.ghost = ghost;
  };

  const cleanup = (d) => {
    d.card?.classList.remove('dragging-src');
    if (!d.active) return false;
    d.ghost?.remove();
    document.body.classList.remove('toc-dragging');
    clearMarks(d.card?.parentElement);
    hideLine();
    return true;
  };

  const bind = (card, meta) => {
    if (!bound) {
      bound = true;
      document.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.active) {
          if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
          activate();
        }
        drag.ghost.style.left = (e.clientX + 10) + 'px';
        drag.ghost.style.top = (e.clientY + 6) + 'px';
        clearMarks(drag.card.parentElement);
        hideLine();
        drag.mode = null; drag.target = null;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el?.closest?.(cardSel);
        // 幽灵前缀（判定前按上一帧 mode 还原/刷新，判定后块尾再刷一次）
        const syncGhost = () => {
          const g = drag.ghost;
          if (!g) return;
          if (drag.mode === 'into' && drag.target) {
            g.innerHTML = `<span class="ghost-parent">${esc(ghostName(drag.target))}/</span>${esc(ghostName(drag.card))}`;
          } else {
            g.textContent = ghostName(drag.card);
          }
        };
        if (target && target !== drag.card && (!validTarget || validTarget(drag.card, target))) {
          const r = target.getBoundingClientRect();
          const frac = (e.clientX - r.left) / r.width;
          if (zones.includes('into')) {
            // 横向三分区（第 108 轮）：左 1/3 = 插前 · 中 1/3 = 移入目标 · 右 1/3 = 插后
            if (frac < 0.34) { target.classList.add('drop-sibling'); showLine(target, false); drag.mode = 'before'; }
            else if (frac > 0.66) { target.classList.add('drop-after'); showLine(target, true); drag.mode = 'after'; }
            else { target.classList.add('drop-into'); hideLine(); drag.mode = 'into'; }
          } else {
            // 二分（世界卡换位没有「移入」语义）：左半 = 插前 · 右半 = 插后
            if (frac < 0.5) { target.classList.add('drop-sibling'); showLine(target, false); drag.mode = 'before'; }
            else { target.classList.add('drop-after'); showLine(target, true); drag.mode = 'after'; }
          }
          drag.target = target;
          syncGhost();
        } else {
          syncGhost();   // 无落点 → 还原原名
        }
      });
      document.addEventListener('pointerup', async () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!cleanup(d)) return;   // 未达阈值 = 普通点击
        // 抑制标志在松手时起算（第 103 轮 → 105 轮 core 守卫）：拖多久都不影响
        armClickGuard();
        if (!d.target || !d.mode) return;
        try { await onDrop?.({ mode: d.mode, src: d.card, target: d.target, meta: d.meta }); }
        catch (err) { console.error('card drop failed:', err); }
      });
      document.addEventListener('pointercancel', () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        cleanup(d);
      });
    }
    card.style.cursor = 'grab';
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.('.world-card-menu')) return;   // 卡上菜单起手 = 点击，不进拖拽
      drag = { meta, sx: e.clientX, sy: e.clientY, active: false, card, mode: null, target: null, ghost: null };
    });
  };

  return { bind };
}
