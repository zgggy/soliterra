// Soliterra 关系图（右 push：一跳邻里 + 拖动扯动 + 悬浮卡；「展开全图」= 全宽；第 92 轮拆分出独立模块）。
import { api, state, navigate, t } from './app.js';
import { enc, esc, showToast, lt, ICON, checkHTML, bindChecks } from './ui.js';
import { topBookNodes, topOfPath } from './world-core.js';
import { showLinkCard, hideCard, leaveAnchor } from './linkcard.js';
import { addReadlater } from './world-readlater.js';
import { download } from './exporter.js';

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


// ============ 关系图（右 push：一跳邻里 + 拖动扯动 + 悬浮卡；「展开全图」= 全宽） ============
export async function renderRel(ctx, mode) {
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
        <input class="text-input rel-search" id="rel-search" placeholder="${t('rel.search')}">
        <span class="rel-tags">${['全部', ...allTags].map((tg) => `<button class="rel-tag${(ctx.graphTag || '全部') === tg ? ' on' : ''}" data-tag="${esc(tg)}">${esc(tg)}</button>`).join('')}</span>
        <button class="icon-button" id="rel-back-mode">← ${t('rel.collapse')}</button>` : `
        ${checkHTML(!!ctx.relBack, lt('relBack'), 'id="rel-back-row"')}
        <button class="icon-button" id="rel-full">${lt('relFull')}</button>`}
      <button class="icon-button${ctx.graphLayout && ctx.graphLayout !== 'force' ? ' active' : ''}" id="rel-layout" title="${t('rel.layoutTip')}">${ctx.graphLayout === 'time' ? '⏱' : ctx.graphLayout === 'tree' ? '⌸' : '⟳'}</button>
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
    panel.querySelector('#rel-canvas').innerHTML = `<div class="empty-state">${t('rel.emptyFull')}</div>`;
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
    const bookOrder = topBookNodes(ctx).map((c) => c.name);
    const groupOf = (p2) => topOfPath(p2);
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
      showToast(t('rel.noTime'), 'warning');
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
      <span class="eyebrow">${t('rel.picked').replace('{n}', picked.length)}</span>
      <button class="button-ghost" data-a="later">✦ ${lt('dashLater')}</button>
      <button class="button-ghost" data-a="only">${t('rel.onlyThese')}</button>
      <button class="button-ghost" data-a="export">${t('rel.exportSub')}</button>
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
        showToast(`${added} ${t('rel.addedLater')}`, 'success');
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
        showToast(t('rel.exported').replace('{n}', sub.nodes.length).replace('{m}', sub.edges.length), 'success');
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
    showToast(t('rel.centered').replace('{n}', n.title), 'success');
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
          showToast(t('rel.pathHint'), 'info');
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

