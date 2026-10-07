// Soliterra 时间轴（功能设计 §3；第 92 轮拆分出独立模块）：initTimeline + 强调（拖到时间轴）。
// 布局规则全部收敛在 timeline-layout.js（纯函数引擎）；本模块只负责显示策略（displayFlagOf）与元素池。
import { state, navigate, t } from './app.js';
import { enc, esc, parseOrd, ICON, showToast } from './ui.js';
import { computeLayout, flagBaseW, LAYOUT, YEAR } from './timeline-layout.js';
import { DEV, currentBookOf, topOfPath, flattenTree } from './world-core.js';

let lastTimelineView = null;     // { world, lo, hi } 当前时间轴视野（重渲染的起点：从现在的值出发）

let axisKeyHandler = null;      // 时间轴键盘 handler 单例（重绑即解绑，防多实例叠加）


// ============ 时间轴（功能设计 §3） ============
export function initTimeline(ctx, wrap, canvas, ticks) {
  const buildItems = () => ctx.timeline.map((r) => {
    let tg = [];
    try { tg = r.tags_json ? JSON.parse(r.tags_json) : []; } catch {}
    // 创世条目（&f 创世 或 &t 含「创世」）：不按 &s 上轴、不计入时间轴总范围；显示在「最早时间之前」
    const genesis = r.flag === '创世' || (Array.isArray(tg) ? tg : String(tg || '').split(/\s+/)).includes('创世');
    return { ...r, s: parseOrd(r.start), e: parseOrd(r.end), era: r.era || null, genesis };
  }).filter((r) => r.s != null || r.genesis);   // 创世无 &s 也保留（创世排不依赖时刻）
  let allItems = buildItems();
  // 时间轴范围 = 本书（§A 二次定型）：顶层散文件文档 → 全库；换书由 setScope 重建
  let items = [];
  const view = { lo: 0, hi: 1 };
  const full = { lo: 0, hi: 1 };
  function rescope(keepView = false) {
    const node = currentBookOf(ctx);
    const inBook = !!(node && node.children && node.children.length);
    items = inBook
      ? (() => { const set = new Set(flattenTree(node).map((e) => e.path)); return allItems.filter((i) => set.has(i.path)); })()
      : allItems;
    // 范围**只由非创世条目定义**（2026-10-06：创世永不参与，任何书/任何视图下皆然）——
    // 本书没有真实时刻（全是创世/无时刻）→ 退回**全库真实范围**，绝不拿创世时刻当范围。
    const timed = items.filter((i) => !i.genesis && i.s != null);
    const base = timed.length ? timed : allItems.filter((i) => !i.genesis && i.s != null);
    if (base.length) {
      const lo = Math.min(...base.map((i) => i.s));
      const hi = Math.max(...base.map((i) => Math.max(i.s, i.e ?? i.s)));   // 末覆盖最晚结束（卡片按开始时间定位，轴尾须容下所有绘制）
      const pad = (hi - lo) * LAYOUT.RANGE_PAD || YEAR;
      full.lo = lo - pad; full.hi = hi + pad;
      if (!keepView) { view.lo = lo - pad; view.hi = hi + pad; }   // 数据刷新（元数据保存）→ 保持当前视野，只更新范围
    }
    earliestOrd = base.length ? Math.min(...base.map((i) => i.s)) : null;
    latestOrd = base.length ? Math.max(...base.map((i) => Math.max(i.s, i.e ?? i.s))) : null;
    // 创世**虚拟时刻**（第 73 轮）：范围起点前 1%（range=0 退 1 年）——由范围派生、**不反馈进范围**（第 62 轮
    // 「创世不计入总范围」不变）；创世的定位/取景/出界带回全部走它 → 缩放、拖动、合并、点击逻辑统一。
    genesisOrd = earliestOrd != null ? earliestOrd - (((latestOrd - earliestOrd) * LAYOUT.GENESIS_RATIO) || YEAR) : null;
    return top;
  }
  let earliestOrd = null, latestOrd = null, genesisOrd = null;
  const axisLine = document.createElement('div');   // 轴线段：只显示范围（最早→最晚时间）内，范围外（含创世排区）不画
  axisLine.className = 'chrono-axis';
  wrap.appendChild(axisLine);
  // 出界指示（§E.4）：bar 左右缘「◀ N / N ▶」——完全在视口外的卡片数；点击平滑取景把最近一批带回
  const hintL = document.createElement('button');
  hintL.className = 'edge-hint left'; hintL.hidden = true;
  hintL.innerHTML = `${ICON.chevronL}<span class="hint-n"></span>`;
  hintL.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  hintL.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (hintL.__ord == null) return;
    const span = view.hi - view.lo;
    animateTo(hintL.__ord - span * 0.25, hintL.__ord + span * 0.75, 300);   // 最近出界卡落到 1/4 屏
  });
  wrap.appendChild(hintL);
  const hintR = document.createElement('button');
  hintR.className = 'edge-hint right'; hintR.hidden = true;
  hintR.innerHTML = `<span class="hint-n"></span>${ICON.chevronR}`;
  hintR.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  hintR.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (hintR.__ord == null) return;
    const span = view.hi - view.lo;
    animateTo(hintR.__ord - span * 0.75, hintR.__ord + span * 0.25, 300);   // 最近出界卡落到 3/4 屏
  });
  wrap.appendChild(hintR);
  // 创世向左渐隐箭头（§E.4）：跟创世组左缘，z 压在卡下（贴边时自然从卡后探出）
  const genesisTail = document.createElement('div');
  genesisTail.className = 'genesis-tail'; genesisTail.hidden = true;
  genesisTail.innerHTML = `${ICON.chevronL}<span class="gt-line"></span>`;
  wrap.appendChild(genesisTail);
  const scopeBook = rescope();
  // 从**当前视图**出发（不跳回默认初值）：同世界同书重渲染沿用上次视野。
  // 打开条目**不加取景**（2026-10-06：删除条目点击的自动缩放）；取景补间仅剩「强调」拖拽与 ⌘K/时代带。
  if (lastTimelineView && lastTimelineView.world === ctx.worldId && lastTimelineView.book === scopeBook) {
    view.lo = lastTimelineView.lo; view.hi = lastTimelineView.hi;
  }
  let anim = null;                // rAF 补间句柄
  const markers = document.createElement('div');
  markers.className = 'chrono-markers';
  wrap.appendChild(markers);
  const eras = document.createElement('div');   // 时代带（§3.2）：轴下 h10
  eras.className = 'chrono-eras';
  wrap.appendChild(eras);
  const flagEls = new Map();     // path -> 旗标元素（跨 layout 复用 → 位置/宽度随缩放平滑过渡）
  const spanEls = new Map();     // path -> 覆盖条元素
  const tickEls = new Map();     // ord -> 刻度元素（第 77 轮复用，替换逐帧 innerHTML 重建）
  const markerEls = new Map();   // ord -> 起止标记元素
  const eraEls = new Map();      // era 名 -> 时代带按钮（点击 handler 一次性绑定，数据存 el.__era）
  const topMemo = new Map();     // path -> 上一帧 top（创世尾箭头单帧滞后取样；第 75 轮起不再写回条目对象）
  let widthRetry = false;        // 实测宽尾随重排的一次性守卫（第 76 轮：新元素/簇成形首帧）

  // ---------- 高模式（§A 修正版）：高度 > 2/3 屏 → 本书全部（有时刻）条目上轴 ----------
  // 显示逻辑与普通模式完全一致（轴线/刻度/按时间定位/引线/分道堆叠都不变），只是面积变大、
  // 上轴的卡片从「&f ∪ 当前 ∪ 强调」扩为本书全部条目；无时刻条目不上轴（无 x 可放）。
  const worldViewEl = wrap.closest('.world-view') || wrap.parentElement;
  let tall = false;                                          // 由 layout() 按 --chrono-h 目标值判定（24px 滞回）
  let flagSetCache = { key: null, map: new Map() };

  /** 当前文档所属书的条目 path→tags（散文件文档 → 全库）；跨导航按 top 缓存。 */
  function bookFlagMap() {
    const top = topOfPath(ctx.currentPath);
    if (flagSetCache.key === top) return flagSetCache.map;
    const node = currentBookOf(ctx);
    const root = (node && node.children && node.children.length) ? node : ctx.tree;
    const map = new Map();
    const walk = (n) => { if (n.md) map.set(n.md, n.tags || []); for (const c of n.children) walk(c); };
    walk(root);
    flagSetCache = { key: top, map };
    return map;
  }

  /** 旗标/卡片元素工厂（跨 layout 复用；事件按 dataset.path 动态寻址）。 */
  function ensureFlagEl(path) {
    let flag = flagEls.get(path);
    if (flag) return flag;
    flag = document.createElement('button');
    flag.dataset.path = path;
    flag.dataset.fresh = '1';                // 新建 → 首次布局时淡入
    flagEls.set(path, flag);
    flag.addEventListener('click', () => {
      if (flag.__unpin) { flag.__unpin = false; return; }
      if (flag.__clusterSpan) {
        if (flag.__clusterOrd != null) focusOrd(flag.__clusterOrd, flag.__clusterSpan);   // 聚合簇（§E.3）：点击 = 取景该时刻（创世 = 虚拟时刻）
        return;
      }
      navigate(`#/w/${enc(ctx.worldId)}/${enc(path)}`);
    });
    const hot = () => {
      spanEls.get(path)?.classList.add('show');
      flag.classList.add('expand'); flag.style.zIndex = (flag.__zi = '90');
      const t = flag.__altTitle ? flag.querySelector('.flag-title') : null;
      if (t) t.textContent = flag.__altTitle;          // 簇：展开显示成员名单
    };
    const restore = () => {
      spanEls.get(path)?.classList.remove('show');
      flag.style.zIndex = (flag.__zi = flag.dataset.z || '10');   // 同步幂等缓存（第 77 轮）
      if (path !== ctx.currentPath) flag.classList.remove('expand');
      const t = flag.__baseTitle ? flag.querySelector('.flag-title') : null;
      if (t) t.textContent = flag.__baseTitle;
    };
    flag.addEventListener('mouseenter', hot);
    flag.addEventListener('mouseleave', restore);
    flag.addEventListener('focus', hot);          // 键盘 focus = hover 同款（§3.8）
    flag.addEventListener('blur', restore);
    canvas.appendChild(flag);
    return flag;
  }

  /** 卡片内容（对比 dataset 防重建）；pinned 时含 × 取消强调。 */
  function paintFlag(flag, { eyebrow, title, date, fuzzy, pinned }) {
    const key = `${eyebrow}|${title}|${date}|${pinned ? 1 : 0}`;
    flag.__paint = key;   // expando 镜像：layout 尾部校验用（避免写后再读 dataset 触发强制样式重算）
    if (flag.dataset.paint === key) return;
    flag.dataset.paint = key;
    flag.dataset.eyebrow = eyebrow;
    flag.dataset.title = title;
    flag.innerHTML = `
      <span class="flag-eyebrow">${esc(eyebrow)}</span>
      <span class="flag-title">${esc(title)}</span>
      <span class="flag-date">${fuzzy ? '≈' : ''}${esc(date)}</span>${pinned ? `<span class="flag-unpin" title="${t('timeline.unpin')}">${ICON.close}</span>` : ''}`;
    flag.querySelector('.flag-unpin')?.addEventListener('click', (e) => {
      e.stopPropagation();
      flag.__unpin = true;
      ctx.pins.delete(flag.dataset.path);
      sessionStorage.setItem(`soliterra.pins.${ctx.worldId}`, JSON.stringify([...ctx.pins]));
      layout();
    });
  }

  /** 显示旗标的条目：带 &f ∪ 创世（&f 或 &t 标记皆恒上轴，第 91 轮修「&t 创世换页即消失」）
   *  ∪ 正在打开的 ∪ 强调 ∪（高模式）本书全部；无时刻条目不上轴。 */
  function displayFlagOf(it) {
    if (it.flag) return it.flag;
    if (it.genesis) return t('timeline.genesisFlag');
    if (it.path === ctx.currentPath) return t('timeline.nowFlag');
    if (ctx.pins.has(it.path)) return t('timeline.pinFlag');
    if (tall) {
      const tags = bookFlagMap().get(it.path);
      if (tags) return tags[0] || t('timeline.entryFlag');
    }
    return '';
  }

  function layout() {
    const width = wrap.clientWidth;
    if (!width) return;
    const t0 = DEV ? performance.now() : 0;   // ?dev=1 探针：整帧（computeLayout + 应用 DOM）耗时
    // 打开卡实测尺寸：**应用前**取样（与本帧样式一致；旧管线亦在应用前读取）
    const oEl0 = flagEls.get(ctx.currentPath);
    const openSize = oEl0 ? { w: oEl0.offsetWidth, h: oEl0.offsetHeight } : null;
    const prevTops = Object.fromEntries(topMemo);   // 上一帧 top（创世尾箭头取样沿用单帧滞后；合并成员保留其上次单独显示的值）
    // 实测宽（第 76 轮）：缓存挂在元素上（__natW/__natPaint/__natCompact）——自然宽经"提上限实测"取得，
    // 引擎取 min(自然宽, 基准宽) = 渲染宽，碰撞箱 ≡ 渲染箱；稳态零 DOM 读取
    const measuredW = {};
    for (const [p, el] of flagEls) if (el.__natW > 0) measuredW[p] = el.__natW;
    // 高模式判定（§A）：高度目标 > 2/3 屏进入（退出阈 2/3 − 24px 滞回）；读 --chrono-h（拖动目标值，非过渡值）
    const hTarget = parseInt(getComputedStyle(worldViewEl).getPropertyValue('--chrono-h')) || 112;
    const t1 = window.innerHeight * 2 / 3;
    tall = tall ? hTarget > t1 - 24 : hTarget > t1;
    // ── 布局引擎（第 75 轮）：纯函数算出整帧（placements/spans/ticks/markers/eras/axis/hints/tail）——
    //    碰撞半箱、first-fit 分道、三类聚簇、创世虚拟时刻、O 卡三通道等规则全部收敛在 timeline-layout.js；
    //    本文件只负责「读输入 → computeLayout → 应用 DOM」+ 显示策略（displayFlagOf）与元素池。
    const pool = new Map(items.map((i) => [i.path, i]));
    for (const i of allItems) if (i.genesis) pool.set(i.path, i);   // 旗标池 = 本书 items ∪ 全世界创世（跨书恒显示）
    const flags = {};
    for (const it of pool.values()) { const e2 = displayFlagOf(it); if (e2) flags[it.path] = e2; }
    const pe0 = DEV ? performance.now() : 0;   // 探针相位：引擎起
    const frame = computeLayout({
      items, genesisAll: allItems, flags,
      view, full, width, chronoH: hTarget, lang: state.lang, currentPath: ctx.currentPath,
      genesisOrd, earliestOrd, latestOrd,
      openSize, prevTops, measuredW,
    });
    const pe1 = DEV ? performance.now() : 0;   // 引擎止
    applyFrame(frame);
    const pa1 = DEV ? performance.now() : 0;   // 应用止
    topMemo.clear();
    for (const p of frame.placements) if (!p.cluster) topMemo.set(p.path, p.top);
    // 实测宽收敛（第 76 轮）：缓存缺失 / 内容变化（paint 签名 + compact）→ 提 --flag-w 上限实测**自然宽**
    // （整批一次同步重排；transition 临时关掉防中间值）；实测与"本帧放置宽"有差异 → 调度**一次** rAF 重排
    // （自终止：重排用上新鲜缓存后 want == w）
    // 实测宽校验（第 76/77 轮）：**纯 expando 比较、零 DOM 读取**——读必须全部发生在 applyFrame 写之前；
    // 写后再读 dataset/style 会强制样式重算（300 卡世界实测 ~20ms/帧，本轮修掉的正是这一处）
    const stale = [];
    for (const p of frame.placements) {
      const el = flagEls.get(p.path);
      if (!el) continue;
      if (el.__natPaint !== el.__paint || el.__natCompact !== frame.compact) stale.push({ p, el });
    }
    if (stale.length) {
      const prevs = stale.map(({ el }) => [el.style.getPropertyValue('--flag-w'), el.style.transition]);
      for (const { el } of stale) { el.style.transition = 'none'; el.style.setProperty('--flag-w', '9999px'); }
      void stale[0].el.offsetWidth;   // 一次同步重排覆盖整批
      let drift = false;
      stale.forEach(({ p, el }, i) => {
        const nat = el.offsetWidth;
        el.__natW = nat; el.__natPaint = el.__paint; el.__natCompact = frame.compact;
        el.style.setProperty('--flag-w', prevs[i][0]);
        el.__fw = null;   // --flag-w 由本段临时改写 → 失效幂等缓存，下帧重写一次
        if (Math.abs(Math.min(nat, flagBaseW(p.title)) - p.w) > 0.75) drift = true;
      });
      void stale[0].el.offsetWidth;   // 上限归位后再结算一次
      // 过渡**下一帧**才恢复：若与取值同帧恢复，规范会按"新样式"为 9999→w 起一段滑回动画，
      // 后台标签页会把它冻在 9999px（盒宽＞上限、卡片互遮）——推迟恢复则后台保持 none（宽度正确），
      // 前台下一帧恢复且不会起滑回动画（rAF 冻结时由 visibilitychange 自愈兜底）
      requestAnimationFrame(() => { stale.forEach(({ el }, i) => { el.style.transition = prevs[i][1]; }); });
      if (drift && !widthRetry) {
        widthRetry = true;
        requestAnimationFrame(() => { widthRetry = false; layout(); });
      }
    }
    // （旗标池装配 / 逐条虚拟时刻 / first-fit 分道 / 三类聚簇 / z 重排 / 同道级联 / O 卡 A·B·C 三通道 /
    //   尾箭头取样 / 出界计数——全部收敛进引擎 timeline-layout.js，本文件不再保留第二份实现）

    lastTimelineView = { world: ctx.worldId, book: topOfPath(ctx.currentPath), lo: view.lo, hi: view.hi };
    if (DEV) {
      const ms = performance.now() - t0;
      const perf = window.__tlPerf = window.__tlPerf || { frames: 0, last: 0, avg: 0, max: 0, engine: 0, apply: 0, items: 0, placements: 0, nodes: 0, h: 0 };
      perf.frames++;
      perf.last = ms;
      perf.avg += (ms - perf.avg) / perf.frames;   // 累计均值（从载入/重置起）
      if (ms > perf.max) perf.max = ms;
      perf.engine += (pe1 - pe0 - perf.engine) / perf.frames;   // 分相：引擎 / 应用
      perf.apply += (pa1 - pe1 - perf.apply) / perf.frames;
      perf.items = items.length;
      perf.placements = frame.placements.length;
      perf.nodes = canvas.children.length + ticks.children.length + markers.children.length + eras.children.length;
      perf.h = hTarget;
    }
  }

  /** 应用一帧布局（引擎输出 → DOM）：元素池复用（跨 layout 只改样式）→ 缩放/改高平滑过渡；本函数不做任何布局计算。 */
  function applyFrame(frame) {
    const zh = state.lang === 'zh-CN';
    const COMPACT = frame.compact;
    // 刻度（第 77 轮：按 ord 元素复用 + 幂等写入；替换逐帧 innerHTML 全量重建）
    const seenTicks = new Set();
    for (const t2 of frame.ticks) {
      let el = tickEls.get(t2.ord);
      if (!el) { el = document.createElement('span'); el.className = 'tick'; tickEls.set(t2.ord, el); ticks.appendChild(el); }
      if (el.__px !== t2.px) { el.__px = t2.px; el.style.left = t2.px + 'px'; }
      if (el.__txt !== t2.text) { el.__txt = t2.text; el.textContent = t2.text; }
      seenTicks.add(t2.ord);
    }
    for (const [k, el] of tickEls) if (!seenTicks.has(k)) { el.remove(); tickEls.delete(k); }
    // 起止标记：范围首尾高刻度（edge）+ 打开文档起止（与标尺同款墨色）——同款复用
    const seenMarkers = new Set();
    for (const m of frame.markers) {
      let el = markerEls.get(m.ord);
      if (!el) { el = document.createElement('span'); markerEls.set(m.ord, el); markers.appendChild(el); }
      const cls = `tick chrono-marker-tick${m.edge ? ' edge' : ''}`;
      if (el.__cls !== cls) { el.__cls = cls; el.className = cls; }
      const title = m.kind === 'start' ? t('timeline.rangeStart')
        : m.kind === 'end' ? t('timeline.rangeEnd') : '';
      if (el.__title !== title) { el.__title = title; if (title) el.title = title; else el.removeAttribute('title'); }
      if (el.__px !== m.px) { el.__px = m.px; el.style.left = m.px + 'px'; }
      if (el.__txt !== m.text) { el.__txt = m.text; el.textContent = m.text; }
      seenMarkers.add(m.ord);
    }
    for (const [k, el] of markerEls) if (!seenMarkers.has(k)) { el.remove(); markerEls.delete(k); }
    // 覆盖条
    const shownSpans = new Set();
    for (const s of frame.spans) {
      let span = spanEls.get(s.path);
      if (!span) {
        span = document.createElement('div');
        span.dataset.path = s.path;
        spanEls.set(s.path, span);
        canvas.appendChild(span);
      }
      // 模糊 = 按端渐隐（§E.4）：引擎已按端解析 `*`（第 76 轮迁入数据层）
      span.className = `span-bar${s.fuzzyS ? ' fuzzy-s' : ''}${s.fuzzyE ? ' fuzzy-e' : ''}${s.isOpen ? ' open' : ''}`;
      span.style.left = s.left + 'px';
      span.style.width = s.width + 'px';
      span.title = s.title;
      shownSpans.add(s.path);
    }
    for (const [p0, el0] of [...spanEls]) if (!shownSpans.has(p0)) { el0.remove(); spanEls.delete(p0); }
    // 旗标（渲染 = 引擎最终排布列表，含簇；全世界创世在池内）
    // 第 77 轮：样式**幂等写入**（与元素缓存值比较，不变不写）——拖动时只有 left 逐帧变，其余全跳过
    const shownFlags = new Set();
    for (const p of frame.placements) {
      const flag = ensureFlagEl(p.path);
      const cls = `event-flag${p.isOpen ? ' open expand' : ''}${ctx.pins.has(p.path) ? ' pinned' : ''}${COMPACT ? ' compact' : ''}${!COMPACT && p.lane > 0 ? ' lane' : ''}`;
      if (flag.__cls !== cls) {
        flag.__cls = cls;
        flag.className = cls;   // 重写会清掉 axis-anchored → 下两行按 p.top 重新断言
        flag.__axis = null;
      }
      const anchored = p.top === 'axis';
      if (flag.__axis !== anchored) { flag.__axis = anchored; flag.classList.toggle('axis-anchored', anchored); }
      if (flag.__z !== p.z) { flag.__z = p.z; flag.dataset.z = String(p.z); }
      if (flag.__left !== p.left) { flag.__left = p.left; flag.style.left = p.left + 'px'; }
      if (flag.__top !== p.top) {
        flag.__top = p.top;
        if (anchored) { flag.style.top = 'auto'; flag.style.bottom = '6px'; }
        else { flag.style.top = p.top + 'px'; flag.style.bottom = 'auto'; }
      }
      const lead = (p.trueX - p.left + 10) + 'px';
      if (flag.__lead !== lead) { flag.__lead = lead; flag.style.setProperty('--lead-x', lead); }   // 引线始终垂在真实开始时刻
      const fw = p.w + 'px';
      if (flag.__fw !== fw) { flag.__fw = fw; flag.style.setProperty('--flag-w', fw); }             // 基础宽 = min(实测自然宽, 基准宽)
      // 打开中的卡片恒最上（z=80；expand 态也被显式置 80，不因 hover 逻辑漏设）——幂等写入；
      // hover 的 hot()/restore() 同步维护 __zi 缓存（第 77 轮）
      if (p.isOpen || !flag.classList.contains('expand')) {
        const wantZ = p.isOpen ? '80' : String(p.z);
        if (flag.__zi !== wantZ) { flag.__zi = wantZ; flag.style.zIndex = wantZ; }
      }
      if (flag.dataset.fresh === '1') {       // 新建卡片淡入（160ms；高分道展开/缩回时同样生效）
        flag.dataset.fresh = '';
        flag.classList.add('card-in');
        flag.addEventListener('animationend', () => flag.classList.remove('card-in'), { once: true });
      }
      paintFlag(flag, { eyebrow: p.eyebrow, title: p.title, date: p.date, fuzzy: p.fuzzy, pinned: ctx.pins.has(p.path) });
      // 聚合簇（§E.3）：点击=取景、hover 换成员名单、原生 title=全名单；解散（同元素复用键）时还原
      if (p.cluster) {
        flag.__clusterOrd = p.cluster.ord;
        flag.__clusterSpan = p.cluster.spanYears;   // 普通簇 = 成员跨度×3（≥1 年）；创世簇 = 全范围 25%
        flag.__baseTitle = p.title;
        flag.__altTitle = p.cluster.altTitle;
        flag.title = p.cluster.memberTitles.join('、');
      } else if (flag.__clusterSpan) {
        flag.__clusterSpan = null; flag.__altTitle = null; flag.__baseTitle = null;
        flag.title = '';
        const t2 = flag.querySelector('.flag-title');
        if (t2) t2.textContent = p.title;
      }
      shownFlags.add(p.path);
    }
    for (const [p0, el0] of [...flagEls]) if (!shownFlags.has(p0)) { el0.remove(); flagEls.delete(p0); }
    // 时代带（§3.2）：同 &a 条目的时间并集，bg/bg-soft 交替 + 名称；点击取景该时代；「更多设置」可关
    // 第 77 轮：按 era 名元素复用，点击 handler **一次性绑定**（读 el.__era，不再逐帧新建按钮/闭包）
    const eraOn = (ctx.settings?.axisEra ?? 'on') !== 'off';
    eras.style.display = eraOn ? '' : 'none';
    const seenEras = new Set();
    for (const e2 of frame.eras) {
      let seg = eraEls.get(e2.name);
      if (!seg) {
        seg = document.createElement('button');
        seg.addEventListener('pointerdown', (ev) => ev.stopPropagation());   // 不触发轴拖拽
        seg.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const cur2 = seg.__era;
          if (!cur2) return;
          const years = Math.max((cur2.hi - cur2.lo) / YEAR, 10);
          focusOrd((cur2.lo + cur2.hi) / 2, years);
        });
        eraEls.set(e2.name, seg);
        eras.appendChild(seg);
      }
      seg.__era = e2;   // lo/hi 每次刷新（点击时读取）
      if (seg.title !== e2.name) seg.title = e2.name;
      const cls = `era-band${e2.alt ? ' alt' : ''}`;
      if (seg.__cls !== cls) { seg.__cls = cls; seg.className = cls; }
      if (seg.__l !== e2.left) { seg.__l = e2.left; seg.style.left = e2.left + 'px'; }
      if (seg.__w !== e2.width) { seg.__w = e2.width; seg.style.width = e2.width + 'px'; }
      if (seg.__nameOn !== e2.showName) {
        seg.__nameOn = e2.showName;
        if (e2.showName) seg.innerHTML = `<span class="era-name">${esc(e2.name)}</span>`;
        else seg.textContent = '';
      }
      seenEras.add(e2.name);
    }
    for (const [k, el] of eraEls) if (!seenEras.has(k)) { el.remove(); eraEls.delete(k); }
    // 轴线段：只画 [最早时间, 最晚时间] 与视口的交集（范围外含创世区无线）
    axisLine.hidden = frame.axis.hidden;
    axisLine.style.left = frame.axis.left + 'px';
    axisLine.style.width = frame.axis.width + 'px';
    // 出界指示（◀ N / N ▶）：点击平滑取景把最近一批带回
    hintL.hidden = frame.hints.offL === 0;
    hintL.__ord = frame.hints.ordL;
    hintL.querySelector('.hint-n').textContent = String(frame.hints.offL);
    hintL.title = t('timeline.offscreen').replace('{n}', frame.hints.offL);
    hintR.hidden = frame.hints.offR === 0;
    hintR.__ord = frame.hints.ordR;
    hintR.querySelector('.hint-n').textContent = String(frame.hints.offR);
    hintR.title = t('timeline.offscreen').replace('{n}', frame.hints.offR);
    // 创世向左渐隐箭头（跟组左缘；组左缘已出屏时隐藏——箭头只标"组的左端在哪"）
    genesisTail.hidden = frame.tail.hidden;
    genesisTail.style.left = frame.tail.left + 'px';
    genesisTail.style.top = frame.tail.top + 'px';
  }

  /** 视野补间：300ms cubic-bezier(.22,1,.36,1)（≈easeOutCubic）；reduced-motion 瞬时。 */
  function animateTo(lo2, hi2, ms = 300) {
    if (anim) cancelAnimationFrame(anim);
    anim = null;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || ms <= 0) { view.lo = lo2; view.hi = hi2; layout(); return; }
    const lo0 = view.lo, hi0 = view.hi, t0 = performance.now();
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const k = ease(p);
      view.lo = lo0 + (lo2 - lo0) * k;
      view.hi = hi0 + (hi2 - hi0) * k;
      layout();
      anim = p < 1 ? requestAnimationFrame(step) : null;
    };
    anim = requestAnimationFrame(step);
  }

  /** 平移钳制（2026-10-06）：视野中心的时刻不得越过范围两端——左右端最多被拖到屏幕正中。
   *  以手势起点 ref 为软边界：已越界（取景开的创世同框等）时不回弹，只禁止继续越界。 */
  function clampPan(lo2, hi2, refLo, refHi) {
    if (earliestOrd == null || latestOrd == null) return [lo2, hi2];
    const span = hi2 - lo2;
    const refC = ((refLo ?? lo2) + (refHi ?? hi2)) / 2;
    const cMin = Math.min(earliestOrd, refC), cMax = Math.max(latestOrd, refC);
    const c = Math.min(Math.max((lo2 + hi2) / 2, cMin), cMax);
    return [c - span / 2, c + span / 2];
  }
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      const d = (e.deltaY / wrap.clientWidth) * (view.hi - view.lo);
      [view.lo, view.hi] = clampPan(view.lo + d, view.hi + d, view.lo, view.hi);
    } else {
      const anchor = view.lo + ((e.clientX - wrap.getBoundingClientRect().left) / wrap.clientWidth) * (view.hi - view.lo);
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const span = (view.hi - view.lo) * factor;
      const ratio = (anchor - view.lo) / (view.hi - view.lo);
      view.lo = anchor - span * ratio;
      view.hi = view.lo + span;
    }
    layout();
  }, { passive: false });

  let dragging = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.event-flag')) return;
    dragging = { x: e.clientX, lo: view.lo, hi: view.hi };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const d = ((e.clientX - dragging.x) / wrap.clientWidth) * (dragging.hi - dragging.lo);
    [view.lo, view.hi] = clampPan(dragging.lo - d, dragging.hi - d, dragging.lo, dragging.hi);
    layout();
  });
  const stop = () => { dragging = null; wrap.classList.remove('dragging'); };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);

  /** 取景补间：&s 落在屏幕 1/3、&e 落在屏幕 2/3（瞬时事件置于 1/3）。300ms。
   *  **打开条目不加取景**（2026-10-06 用户要求：删除所有条目点击的自动缩放；想看上哪条自己拖）+ 创世无时间语义不取景。
   *  仅剩「强调」拖拽（显式手势，把条目拖进屏幕）调用本函数。 */
  function focusPath(path) {
    const it = items.find((i) => i.path === path);
    if (!it) return;
    if (it.genesis) {   // 创世：取景到**虚拟时刻**（仅「强调」拖拽显式手势触发；打开条目不调用本函数）
      if (genesisOrd != null) focusOrd(genesisOrd, Math.max(((full.hi - full.lo) / YEAR) * LAYOUT.GENESIS_SPAN, 1));
      return;
    }
    const s = it.s;
    const e = it.e != null && it.e > it.s ? it.e : null;
    const dur = e != null ? e - s : Math.max(YEAR, (full.hi - full.lo) * LAYOUT.ZOOM_DUR_RATIO);
    animateTo(s - dur, (e ?? s) + dur, 300);
  }

  // 拖到时间轴 = 强调该条目
  wrap.addEventListener('dragover', (e) => {
    const from = ctx.dragPath || sessionStorage.getItem('soliterra.dragPath');
    if (!from) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    wrap.classList.add('drop-emphasis');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-emphasis'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop-emphasis');
    const from = ctx.dragPath || sessionStorage.getItem('soliterra.dragPath');
    if (from) emphasize(ctx, from);
  });

  /** ⌘K 日期取景：以 ord 为中心、spanYears 为跨度。 */
  function focusOrd(ord, spanYears = 100) {
    hoverBaseReset();
    const span = Math.max(spanYears * YEAR, YEAR);
    animateTo(ord - span / 2, ord + span / 2, 300);
  }
  function hoverBaseReset() { /* 预留：取景不参与 hover 还原 */ }

  // 键盘无障碍（§3.8）：T 聚焦时间轴 → ←/→ 平移、+/− 中心缩放、Esc 退出；旗标 Tab 聚焦=hover 同款
  wrap.tabIndex = -1;
  wrap.addEventListener('focus', () => wrap.classList.add('chrono-kb'));
  wrap.addEventListener('blur', () => wrap.classList.remove('chrono-kb'));
  if (axisKeyHandler) window.removeEventListener('keydown', axisKeyHandler);   // 单例：旧实例必须解绑（多 renderWorld 曾叠加多份 → 视图打架）
  axisKeyHandler = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 会话态 = class（T 显式管理，程序化 focus 在部分环境不可靠）或 真焦点
    const inAxis = wrap.classList.contains('chrono-kb') || document.activeElement === wrap;
    if (document.activeElement !== wrap && !wrap.classList.contains('chrono-kb')) wrap.classList.remove('chrono-kb');
    const k = e.key;
    if (!inAxis && (k === 't' || k === 'T')) {
      e.preventDefault();
      wrap.focus();
      wrap.classList.add('chrono-kb');                 // 程序化 focus 在部分环境不派发事件 → 显式管理
      return;
    }
    if (!inAxis) return;
    if (k === 'Escape') { e.preventDefault(); wrap.blur(); wrap.classList.remove('chrono-kb'); return; }   // 第 127 轮：让位给 handleKeys（Esc=面板开关），本键只收轴
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const d = (view.hi - view.lo) * (k === 'ArrowLeft' ? -0.1 : 0.1);
      animateTo(view.lo + d, view.hi + d, 150);
      return;
    }
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      e.preventDefault();
      const mid = (view.lo + view.hi) / 2;
      const span = (view.hi - view.lo) * ((k === '-' || k === '_') ? 1.3 : 1 / 1.3);
      animateTo(mid - span / 2, mid + span / 2, 150);
    }
  };
  window.addEventListener('keydown', axisKeyHandler);

  window.addEventListener('resize', layout);
  // 回前台自愈（第 76 轮）：后台标签页会冻结 CSS 过渡（max-width 悬停展开可卡在中间值、宽于上限）——
  // 回前台时关过渡 → 重排（写入目标上限）→ 强制结算 → 恢复过渡（数值未变，不会重新触发动画）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const el of flagEls.values()) el.style.transition = 'none';
    layout();
    void canvas.offsetWidth;
    for (const el of flagEls.values()) el.style.transition = '';
  });
  return {
    layout, focusPath, focusOrd, isTall: () => tall, view,
    setScope: () => { rescope(); layout(); },
    /** 是否为创世条目（打开创世 = 不动时间轴分毫的判断依据）。 */
    isGenesis: (p) => { const i = allItems.find((x) => x.path === p); return !!(i && i.genesis); },
    /** 数据刷新（元数据/工具改动后）：重取 timeline → 重建条目 → 范围重算（**视野不跳**）→ 重排。 */
    reload: (rows) => { if (rows) ctx.timeline = rows; allItems = buildItems(); rescope(true); layout(); },
  };
}


/** 强调条目：拖到时间轴 → 持久保留在时间轴上（旗标 × 可取消）+ 聚焦 + 脉冲高亮。 */
export function emphasize(ctx, path) {
  const it = ctx.timeline.find((i) => i.path === path);
  if (!it) {
    showToast(t('timeline.noMarkers'), 'warning');
    return;
  }
  ctx.pins.add(path);
  sessionStorage.setItem(`soliterra.pins.${ctx.worldId}`, JSON.stringify([...ctx.pins]));
  ctx.chrono?.focusPath(path);
  ctx.chrono?.layout();
  requestAnimationFrame(() => {
    document.querySelectorAll('.pulse').forEach((n) => n.classList.remove('pulse'));
    const nodes = [...document.querySelectorAll('.chrono-canvas [data-path]')].filter((n) => n.dataset.path === path);
    nodes.forEach((n) => n.classList.add('pulse'));
    showToast(t('timeline.pinned').replace('{n}', it.title), 'success');
  });
}

