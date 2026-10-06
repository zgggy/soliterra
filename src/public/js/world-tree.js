// Soliterra 目录树（第 92 轮拆分）：树渲染 / 右键结构菜单 / pointer 拖拽（跨层移动 + 同层 &r 重排序）。
import { api, state, navigate } from './app.js';
import { enc, esc, showToast, askText } from './ui.js';
import { worldDataCache, tocOpenDirs, hooks, refreshGitStatus, currentBookOf, rootNodeOf, topOfPath, firstEntryOf, flattenTree, topBookNodes } from './world-core.js';
import { emphasize } from './world-timeline.js';

// ============ 结构操作（§5.4 ②③④ + 重命名/删除）：右键菜单 ============
export async function refreshTree(ctx) {
  worldDataCache.delete(ctx.worldId);
  ctx.tree = await api(`/api/w/${enc(ctx.worldId)}/tree`);
  worldDataCache.set(ctx.worldId, { tree: ctx.tree, timeline: ctx.timeline, ts: Date.now() });
  renderToc(ctx);
  if (document.getElementById('books-grid')) hooks.renderBooksPanel?.(ctx);   // 书籍面板在场时同步重绘（第 79 轮：面板内改书后即时反映）
}

export function closeTreeMenu() { document.querySelectorAll('.tree-menu').forEach((m) => m.remove()); }

export function showTreeMenu(e, ctx, node) {
  e.preventDefault();
  closeTreeMenu();
  const menu = document.createElement('div');
  menu.className = 'tree-menu';
  const hasMd = !!node.md;
  const inDir = node.dir || '';
  const isDirNode = !!inDir && !hasMd;   // 纯目录节点（无同名 md，如「黄金时代/」）：第 80 轮起与书同等管理
  const zh = state.lang === 'zh-CN';
  const items = [];
  if (inDir) items.push(['add', zh ? '下方加条目（同级）' : 'Add sibling below']);
  if (inDir && !hasMd) items.push(['child', zh ? '子条目（下一级）' : 'Add child entry']);
  else if (inDir) items.push(['child', zh ? '子条目（下一级，建目录）' : 'Add child (with folder)']);
  if (isDirNode) items.push(['pair', zh ? '补建同名条目（成为书）' : 'Create paired entry']);
  if (hasMd) items.unshift(['detail', zh ? '书籍详情（封面/统计）' : 'Book details']);
  if (hasMd || isDirNode) items.push(['rename', zh ? '重命名' : 'Rename']);
  // 第 90 轮语义：书无删除只有归档（`书.md` → `书.md.arc`）；条目 = 归档 + 删除（移入回收站）
  const isTopBook = !inDir.includes('/') || (inDir.startsWith('books/') && !inDir.slice('books/'.length).includes('/'));
  if (hasMd || isDirNode) items.push(['arc', zh ? '归档（从平台隐藏，文件保留）' : 'Archive (hidden, files kept)']);
  if ((hasMd || isDirNode) && !isTopBook) items.push(['del', zh ? '删除（移入回收站）' : 'Delete (trash)']);
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
      if (k === 'detail') { hooks.openBookDetail?.(ctx, node); return; }
      if (k === 'add' || k === 'child') {
        const label = k === 'add'
          ? (state.lang === 'zh-CN' ? '新条目名（插到下方）' : 'New entry name (below)')
          : (state.lang === 'zh-CN' ? '子条目名' : 'Child name');
        const name = await askText(label);
        if (!name || !name.trim()) return;
        // 第 94 轮语义：add = **同级**（父目录）插到选中项下方并整层 &r 重排；child = **下一级**（node.dir）
        const targetDir = k === 'add' ? parentDirOf(node.dir) : inDir;
        if (k === 'add' && !targetDir) {
          showToast(state.lang === 'zh-CN'
            ? '世界根只放 README 与 books/ —— 请先在书籍里操作，或用书籍面板 ＋ 建书'
            : 'World root only holds README and books/ — create a book first', 'warning');
          return;
        }
        const r2 = await api(`/api/w/${enc(ctx.worldId)}/fs/create`, { method: 'POST', body: { dir: targetDir, name: name.trim(), pair: k === 'child' } });
        if (k === 'add' && r2.path) {
          await refreshTree(ctx);                       // 新条目进树后才能定位同层
          await insertBelow(ctx, node, r2.path);        // 插到选中项下方（整层 &r 连续化）
        }
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
      } else if (k === 'arc') {
        const label = node.title || node.name;
        const rel = node.md || inDir;
        const conf = await askText(state.lang === 'zh-CN'
          ? `归档「${label}」？输入「归档」确认（本地文件保留：${isTopBook ? '书.md → 书.md.arc' : '移入 books/archives/'}，可随时还原）`
          : `Type 归档 to confirm archiving ${label}`);
        if (conf !== '归档') { if (conf !== null) showToast(state.lang === 'zh-CN' ? '未确认，未归档' : 'Not confirmed', 'warning'); return; }
        await api(`/api/w/${enc(ctx.worldId)}/fs/archive`, { method: 'POST', body: { rel } });
        ctx.archives = null;   // 归档视图重取
        await after(state.lang === 'zh-CN' ? `已归档：${label}（可在书籍面板「归档」中还原）` : `Archived: ${label}`);
        const base = String(rel).replace(/\.md$/i, '');
        if (ctx.currentPath === node.md || (isDirNode && ctx.currentPath && ctx.currentPath.startsWith(inDir + '/')) || (ctx.currentPath || '').startsWith(base + '/')) {
          navigate(`#/w/${enc(ctx.worldId)}`);
        }
      } else if (k === 'del') {
        // 两步确认（不弹原生 confirm）
        const label = node.title || node.name;
        const conf = await askText(state.lang === 'zh-CN' ? `删除「${label}」？输入「删除」确认（将移入回收站）` : `Type 删除 to confirm deleting ${label}`);
        if (conf !== '删除') { if (conf !== null) showToast(state.lang === 'zh-CN' ? '未确认，未删除' : 'Not confirmed', 'warning'); return; }
        // 第 94 轮：删的是正在读的条目 → 刷新后原地跳先序后继（同世界 update，目录面板与展开态保持），
        // 绝不回世界根（那是「没打开任何书籍」的落点）。删除前先记后继位置。
        const wasCurrent = ctx.currentPath === node.md || (isDirNode && ctx.currentPath && ctx.currentPath.startsWith(inDir + '/'));
        const succPos = wasCurrent ? flattenTree(ctx.tree).findIndex((x) => x.path === ctx.currentPath) : -1;
        if (isDirNode) {
          await api(`/api/w/${enc(ctx.worldId)}/fs/delete`, { method: 'POST', body: { path: inDir } });
          await after(state.lang === 'zh-CN' ? '已移入回收站（.soliterra/trash-*）' : 'Moved to trash');
          if (wasCurrent) gotoSuccessor(ctx, succPos);
          return;
        }
        await api(`/api/w/${enc(ctx.worldId)}/fs/delete`, { method: 'POST', body: { path: node.md } });
        await after(state.lang === 'zh-CN' ? '已移入回收站（.soliterra/trash-*）' : 'Moved to trash');
        if (wasCurrent) gotoSuccessor(ctx, succPos);
      }
    } catch (err) { showToast(String(err.message), 'error'); }
  });
  const off = (ev) => { if (!menu.contains(ev.target)) { closeTreeMenu(); document.removeEventListener('pointerdown', off); } };
  document.addEventListener('pointerdown', off);
}

// ============ 目录树 ============
// 只显示当前书（顶层节点）的子树；递归展开到当前文档；子节点紧贴父级；行高亮当前文档。
export function renderToc(ctx) {
  const body = document.getElementById('toc-body');
  if (!body) return;
  // 第 92 轮：重渲染前快照当前展开态（含 containsCurrent 自动展开的祖先）→ 写回 tocOpenDirs——
  // 拖动改序 / 移动 / 外部刷新后目录保持用户眼前的展开状态，不再整体收起。
  for (const sub of body.querySelectorAll('.toc-children:not([hidden])')) {
    const dir = sub.previousElementSibling?.querySelector?.('.toc-row')?.dataset?.dir;
    if (dir) tocOpenDirs.add(dir);
  }
  body.innerHTML = '';

  const defaultBook = rootNodeOf(ctx);
  const book = currentBookOf(ctx) || defaultBook;
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
      // 第 94 轮：**点击有子条目的行 = 切换展开/收起**（无论有无配对 md——打开走其子条目或书籍面板）
      row.addEventListener('click', () => { if (!window.__tocDragged) arrow.click(); });
    } else {
      arrow.textContent = '·';
      arrow.classList.add('leaf');
      // 叶子条目：点击 = 打开
      if (isOpenable) row.addEventListener('click', () => { if (!window.__tocDragged) navigate(`#/w/${enc(ctx.worldId)}/${enc(node.md)}`); });
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
export function updateTocCurrent(ctx, path) {
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
    document.querySelectorAll('.toc-row.drop-into, .toc-row.drop-sibling, .toc-row.drop-after').forEach((n) => n.classList.remove('drop-into', 'drop-sibling', 'drop-after'));
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
      // 第 103 轮：抑制标志改在**松手时**起算（原按下起算 → 拖 >400ms 松手后 click 漏拦）
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
      // 第 91 轮：同父级直接子女之间 = 重排序（上半=插到目标之前，下半=插到目标之后）——
      // 整层顺序落 `&r`；跨父级保持原移动语义（上半=移到目标父目录，下半=移入目标目录）。
      // 同父级书目录的「移入」仍可达：拖到其子行的上半（= 移到该子行父目录）。
      const rowDir = row.dataset.dir || '';
      const dragDir = tocDrag.node?.dir || '';
      if (parentDirOf(rowDir) === parentDirOf(dragDir) && parentDirOf(tocDrag.movePath) === parentDirOf(dragDir)) {
        row.classList.add(into ? 'drop-after' : 'drop-sibling');
        tocDrag.mode = into ? 'after' : 'before';
        tocDrag.target = row;
        return;
      }
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
    window.__tocDragged = true;   // 从松手起算 400ms（第 103 轮）
    setTimeout(() => { window.__tocDragged = false; }, 400);
    if (d.mode === 'emphasize') { emphasize(ctx, d.movePath); return; }
    if (d.mode === 'before' || d.mode === 'after') { await doReorder(ctx, d.node, d.target, d.mode); return; }
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

// ============ 树内重排序（第 91 轮：同父级拖动 → 整层顺序写 `&r`，1 起） ============
/** 按路径在树中找节点（dir 即完整前缀路径，树内唯一）。 */
function tocNodeOf(root, dir, md) {
  if (dir && root.dir === dir) return root;
  for (const c of root.children || []) {
    const hit = tocNodeOf(c, dir, md);
    if (hit) return hit;
  }
  return null;
}

/** 找 target 所在的父节点（其 children 数组即同层序列）。 */
function tocParentOf(root, target) {
  for (const c of root.children || []) {
    if (c === target) return root;
    const hit = tocParentOf(c, target);
    if (hit) return hit;
  }
  return null;
}

/** 节点级同层重排（第 101 轮抽出，目录行与书籍面板卡片共用）：
 *  同父才可（跨层无排序语义）；按 md/dir 在当前树中重查引用（拖拽期间树刷新也不失效）；
 *  整层 &r 1..N 连续化写入。成功 true；不符 false。 */
export async function reorderNode(ctx, drag, target, mode) {
  if (!drag || !target || drag === target) return false;
  const d = (drag.md && tocNodeByMd(ctx.tree, drag.md)) || tocNodeOf(ctx.tree, drag.dir || '', drag.md || '');
  const tg = (target.md && tocNodeByMd(ctx.tree, target.md)) || tocNodeOf(ctx.tree, target.dir || '', target.md || '');
  if (!d || !tg || d === tg) return false;
  const parent = tocParentOf(ctx.tree, tg);
  if (!parent || tocParentOf(ctx.tree, d) !== parent) return false;   // 同父才可（书卡跨层防误）
  const siblings = parent.children;
  const from = siblings.indexOf(d);
  if (from < 0) return false;
  siblings.splice(from, 1);
  let idx = siblings.indexOf(tg);
  if (idx < 0) { siblings.splice(from, 0, d); return false; }   // 目标不在同层 → 原地放回
  if (mode === 'after') idx += 1;
  siblings.splice(idx, 0, d);
  try {
    // 顺序清单 = 整层新序列（md 路径；纯目录服务端自动跳过）→ &r 1..N 连续化
    await api(`/api/w/${enc(ctx.worldId)}/fs/order`, { method: 'POST', body: { dir: parent.dir || '', order: siblings.map((n) => n.md || n.dir) } });
    await refreshTree(ctx);
    refreshGitStatus(ctx);
    showToast(state.lang === 'zh-CN' ? '已调整顺序' : 'Reordered', 'success');
    return true;
  } catch (e) {
    showToast(String(e.message), 'error');
    await refreshTree(ctx);   // 失败回滚到服务端真实顺序
    return false;
  }
}

async function doReorder(ctx, dragNode, targetRow, mode) {
  const drag = tocNodeOf(ctx.tree, dragNode?.dir || '', dragNode?.md || '');
  const target = tocNodeOf(ctx.tree, targetRow?.dataset?.dir || '', targetRow?.dataset?.path || '');
  return reorderNode(ctx, drag, target, mode);
}


// ============ 第 94 轮：右键「下方加条目」插序与「删除后落点」 ============
/** 按 md 路径在树中找节点（dir 反查会命中父节点自身 → md 精确匹配才可靠）。 */
function tocNodeByMd(root, md) {
  if (md && root.md === md) return root;
  for (const c of root.children || []) { const hit = tocNodeByMd(c, md); if (hit) return hit; }
  return null;
}

/** 新条目插到选中项下方：同层 children 重排 → 整层 &r 连续化（纯目录节点服务端自动跳过）。
 *  refreshTree 后旧 node 引用过期 → 按 md 路径在新树中重查。 */
async function insertBelow(ctx, selNode, newMdPath) {
  const selMd = selNode?.md;
  if (!selMd) return;
  const sel = tocNodeByMd(ctx.tree, selMd);
  const parent = sel ? tocParentOf(ctx.tree, sel) : null;
  if (!parent) return;
  const kids = parent.children;
  const selIdx = kids.findIndex((c) => c === sel || (c.md && c.md === selMd));
  const newNode = kids.find((c) => c.md === newMdPath);
  if (selIdx < 0 || !newNode) return;
  kids.splice(kids.indexOf(newNode), 1);
  kids.splice(selIdx + 1, 0, newNode);
  try {
    await api(`/api/w/${enc(ctx.worldId)}/fs/order`, { method: 'POST', body: { dir: parent.dir || '', order: kids.map((c) => c.md || c.dir) } });
  } catch (e) { showToast(String(e.message), 'error'); return; }
  await refreshTree(ctx);   // &r 生效 → 树按新顺序重排（after 还会再刷一次，幂等）
}

/** 删当前条目后的落点（第 94 轮）：先序后继 → 前一条 → 首条——同世界原地导航（update 不重建页面，
 *  目录面板与展开态保持）；树空才回世界根（最后手段）。 */
function gotoSuccessor(ctx, succPos) {
  const list = flattenTree(ctx.tree);
  if (!list.length) { navigate(`#/w/${enc(ctx.worldId)}`); return; }
  const target = (succPos >= 0 && list[succPos]) || (succPos > 0 && list[succPos - 1]) || list[0];
  navigate(`#/w/${enc(ctx.worldId)}/${enc(target.path)}`);
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

