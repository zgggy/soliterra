// Soliterra 世界共享状态与树导航（第 92 轮拆分）：数据缓存 / 目录展开记忆 / 树辅助 / git 状态与时间轴刷新。
// hooks = 拆分桥接点：world.js 注册 renderBooksPanel / openEntry，tree·meta 模块经此回调（避免相互 import 环）。
import { api, state } from './app.js';
import { enc, lt } from './ui.js';

export const hooks = {};

export const worldDataCache = new Map();   // worldId -> { tree, timeline, ts }
export const DEV = new URLSearchParams(location.search).has('dev');   // ?dev=1 → 每帧更新 window.__tlPerf（第 77 轮探针）
export const tocOpenDirs = new Set();    // 目录手动展开的目录（跨重渲染记忆，防闪回）


export async function refreshGitStatus(ctx) {
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

export function firstEntryOf(node) {
  if (node.md) return node.md;
  for (const c of node.children) { const r = firstEntryOf(c); if (r) return r; }
  return null;
}

/** 根条目节点（第 88 轮约定）：README.md 优先 → 历史 `<世界名>` 节点 → 第一本书 → 第一子节点。 */
export function rootNodeOf(ctx) {
  const kids = ctx.tree?.children || [];
  return kids.find((c) => c.md === 'README.md' || c.name === 'README')
    || topBookNodes(ctx).find((c) => c.name === ctx.worldId)   // 世界名书（迁入 books/ 后仍认）
    || topBookNodes(ctx)[0]
    || kids[0] || null;
}

/** 书籍容器（第 89 轮规范）：顶层 `books` 目录节点（无同名 md）即书籍之家；无则回落旧形态。 */
export function bookHost(ctx) {
  return (ctx.tree?.children || []).find((c) => c.name === 'books' && !c.md) || null;
}

/** 顶层书籍节点序列：books/ 直接子节点在前；**未被迁移的旧形态顶层节点照常可见**（混合世界不丢行）。
 *  剔除 README（世界介绍，不是书）与 assets 容器。 */
export function topBookNodes(ctx) {
  const kids = ctx.tree?.children || [];
  const bc = bookHost(ctx);
  const own = kids.filter((c) => c !== bc && c.name !== 'README' && c.name !== 'assets');
  return bc ? [...bc.children, ...own] : own;
}

/** 路径 → 顶层书名（剥 `books/` 前缀）。 */
export function topOfPath(p) {
  const segs = (p || '').split('/');
  const head = segs[0] === 'books' && segs.length > 1 ? segs[1] : segs[0];
  return (head || '').replace(/\.md$/i, '');
}

/** 当前条目所属的顶层书籍节点（散文件 / 根条目 → null）。 */
export function currentBookOf(ctx) {
  const p = ctx.currentPath || '';
  return topBookNodes(ctx).find((c) => c.dir && (p === c.md || p.startsWith(c.dir + '/'))) || null;
}


/** 元数据改动后的时间轴数据刷新：重取 timeline（服务端已重索引）→ 原地重建条目与范围，视野不跳。 */
export async function refreshTimeline(ctx) {
  worldDataCache.delete(ctx.worldId);
  try {
    const rows = await api(`/api/w/${enc(ctx.worldId)}/timeline`);
    ctx.chrono?.reload?.(rows);
  } catch {}
}

/** 树展平（先序）/ 前后条目导航——树辅助共用。 */
export function flattenTree(node, out = []) {
  if (node.md) out.push({ path: node.md, title: node.title || node.name });
  for (const c of node.children) flattenTree(c, out);
  return out;
}
export function nextEntry(tree, path) {
  const list = flattenTree(tree);
  const i = list.findIndex((x) => x.path === path);
  return i >= 0 ? list[i + 1] : null;
}
export function prevEntry(tree, path) {
  const list = flattenTree(tree);
  const i = list.findIndex((x) => x.path === path);
  return i > 0 ? list[i - 1] : null;
}
