// 时间轴布局引擎（第 75 轮抽取，纯函数：零 DOM / 零依赖）——浏览器（world.js）与 node 测试共用。
// 规则单点真相：碰撞半箱（左 1/2 检测箱）、越晚 z 越高、三类互斥聚合簇、创世逐条虚拟时刻、
//   打开卡恒 z80 贴轴、范围只由非创世定义、first-fit 分道、O 卡三通道（A 创世 / B 右移越创世 / C 带内让位）。
// 改布局只改本文件 + LAYOUT 常量表；world.js 只负责「读输入 → computeLayout → 应用 DOM」。

export const YEAR = 365.25;

/** 布局常量（单点可调；改这里 = 全时间轴行为变化）。 */
export const LAYOUT = {
  GAP: 10,             // 半箱让位最小间距（级联 / O 链 / 创世虚拟排布共用）
  CLUSTER_GAP: 10,     // 聚合簇相邻左缘阈值（px，随缩放自动松紧）
  MIN_CLUSTER: 3,      // 成簇最小张数
  FLAG_H: 52,          // 卡片高（分道步距 = FLAG_H + LANE_GAP）
  LANE_GAP: 6,         // 相邻道叠片（≤ 该值属设计）
  LANE_TOP: 10,        // 首道 top
  GENESIS_RATIO: 0.01, // 创世虚拟时刻 = 范围起点前 range × 该比例（range=0 退 1 年）
  RANGE_PAD: 0.05,     // 范围两端各留 = range × 该比例的内边距（world.js rescope 同读此值）
  GENESIS_SPAN: 0.25,  // 创世取景跨度 = 全范围 × 该比例（feat: 成员同刻跨度为 0，深缩会把轴首推出屏外）
  CLUSTER_SPAN_X: 3,   // 普通簇取景跨度 = 成员跨度 × 该系数（≥ 1 年）
  ZOOM_DUR_RATIO: 0.02,// 瞬时条目取景标称时长 = 全范围 × 该比例（≥ 1 年）
  BASE_Z: 10,          // z 起点（按时间序 +1）
  OPEN_Z: 80,          // 打开卡恒最上
  COMPACT_H: 84,       // 高度低于此 → compact（只显标题）
  OPEN_H: 64,          // 打开卡实测高缺失时兜底（compact 用 OPEN_H_COMPACT）
  OPEN_H_COMPACT: 26,
  EDGE_MARGIN: 2,      // 出界判定：完全在视口外（left + w < 2 / left > width − 2）
  MARKER_SAME_GAP: 24, // 起止标记就近让位
  MARKER_PAD: 40,      // 标记出屏余量
  TICK_MARKER_GAP: 30, // 刻度 vs 标记让位
  TICK_PAD: 20,        // 刻度出屏余量
  TICK_MIN_PX: 90,     // 刻度步长目标间距
  ERA_PAD: 60,         // 时代带出屏余量
  ERA_NAME_MIN: 72,    // 时代名显示最小宽
  ERA_MIN_W: 10,       // 时代带最小宽
  O_SHIFT_PASS: 4,     // B 通道 O 右移循环上限
};

export const TICK_STEPS = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** 时间序 → 首字母（拼音）序：z 排名 / 旗标排序共用。 */
const cmpTime = (a, b) => ((a.s ?? -Infinity) - (b.s ?? -Infinity))
  || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');

/** 旗标基础宽：按字数（最多 4 字；不足 4 字按实际字数收窄）。 */
export const flagBaseW = (title) => Math.min(String(title).length, 4) * 14 + 22;

/** 刻度步长：使相邻刻度 ≥ TICK_MIN_PX 的最小档（视宽 0 时按 1200 估算）。 */
export function tickStepFor(width, span) {
  const perYear = (width || 1200) / (span / YEAR);
  return TICK_STEPS.find((s) => s >= LAYOUT.TICK_MIN_PX / perYear) || 10000;
}

/**
 * 计算一帧时间轴布局。
 *
 * 输入：
 *  - items      本书条目 [{path,title,s,e,start,end,instant,fuzzy,flag,era,genesis}]
 *  - genesisAll 全世界创世条目（旗标池补充：跨书恒显示）
 *  - flags      path → 眉题（'' = 不上轴）——displayFlagOf 的结果（显示策略留在 world.js）
 *  - view/full  {lo,hi}；width 画布宽；chronoH = --chrono-h 目标值
 *  - lang / currentPath / genesisOrd / earliestOrd / latestOrd
 *  - openSize   打开卡实测尺寸 {w,h}（元素存在时）；null → 基宽/兜底高
 *  - measuredW  path → 旗标**自然宽**（渲染实测：scrollWidth + 边框；缺省 → 基准宽）——
 *               引擎取 min(实测, 基准宽) = 渲染宽 → 碰撞箱 ≡ 渲染箱（第 76 轮）
 *  - prevTops   path → 上一帧 top（创世尾箭头的高度取样沿用既有单帧滞后行为）
 *
 * 输出 frame：
 *  - compact, placements[], spans[], ticks[], markers[], eras[], axis{}, hints{}, tail{}
 */
export function computeLayout(input) {
  const {
    items = [], genesisAll = [], flags = {},
    view, full, width, chronoH,
    lang = 'zh-CN', currentPath = null,
    genesisOrd = null, earliestOrd = null, latestOrd = null,
    openSize = null, prevTops = {}, measuredW = {},
  } = input;
  const zh = lang === 'zh-CN';
  const {
    GAP, CLUSTER_GAP, MIN_CLUSTER, FLAG_H, LANE_GAP, LANE_TOP, GENESIS_RATIO,
    GENESIS_SPAN, CLUSTER_SPAN_X,
    BASE_Z, OPEN_Z, COMPACT_H, OPEN_H, OPEN_H_COMPACT, EDGE_MARGIN,
    MARKER_SAME_GAP, MARKER_PAD, TICK_MARKER_GAP, TICK_PAD,
    ERA_PAD, ERA_NAME_MIN, ERA_MIN_W, O_SHIFT_PASS,
  } = LAYOUT;
  const x = (ord) => ((ord - view.lo) / (view.hi - view.lo)) * width;
  const yLabel = (ord) => { const y = Math.floor(ord / YEAR); return y < 0 ? `前${Math.abs(y)}` : String(y); };   // 0847.08 不得四舍五入成 848
  /** 旗标宽（第 76 轮：碰撞箱 = 渲染箱）——min(自然宽实测, 基准宽)；无实测（新元素首帧）→ 基准宽兜底。 */
  const wOf = (title, path) => Math.min(measuredW[path] > 0 ? measuredW[path] : Infinity, flagBaseW(title));

  // ── 起止标记 + 刻度（轴下方：打开文档起止 + 范围首尾高刻度；常规刻度让位）
  const markers = [];
  const markerPx = [];
  const addMarker = (ord, kind) => {
    if (ord == null) return;
    const px = x(ord);
    if (px < -MARKER_PAD || px > width + MARKER_PAD) return;
    if (markerPx.some((mp) => Math.abs(mp - px) < MARKER_SAME_GAP)) return;   // 就近让位（同年份同位不重复绘）
    markerPx.push(px);
    markers.push({ px, ord, text: yLabel(ord), edge: kind !== 'cur', kind });   // ord = 元素复用稳定键（第 77 轮）
  };
  addMarker(earliestOrd, 'start');
  addMarker(latestOrd, 'end');
  const curItem = items.find((i) => i.path === currentPath);
  if (curItem && !curItem.genesis) {   // 创世条目无时间语义，不起止标记
    addMarker(curItem.s, 'cur');
    if (curItem.e != null && curItem.e > curItem.s) addMarker(curItem.e, 'cur');
  }
  const step = tickStepFor(width, view.hi - view.lo);
  const ticks = [];
  const y0 = Math.floor((view.lo / YEAR) / step) * step;
  const y1 = Math.ceil((view.hi / YEAR) / step) * step;
  let guard = 0;
  for (let y = y0; y <= y1 && guard < 400; y += step, guard++) {
    const ord = y * YEAR;
    if (earliestOrd != null && (ord < earliestOrd || ord > latestOrd)) continue;   // 范围外不刻度
    const px = x(ord);
    if (px < -TICK_PAD || px > width + TICK_PAD) continue;
    if (markerPx.some((mp2) => Math.abs(mp2 - px) < TICK_MARKER_GAP)) continue;   // 让位起止标记
    ticks.push({ px, ord, text: yLabel(ord) });   // ord = 元素复用稳定键（第 77 轮）
  }

  // ── 旗标池 = 本书 items ∪ **全世界创世条目**（跨书恒显示：创世是世界本源，点进任何书/文档都不消失）
  const pool = new Map(items.map((i) => [i.path, i]));
  for (const i of genesisAll) if (i.genesis) pool.set(i.path, i);
  // 浅拷贝：引擎不改 world.js 的活对象（placements 携带全部结果）
  const flagItems = [...pool.values()].filter((i) => flags[i.path]).map((i) => ({ ...i })).sort(cmpTime);
  const genesisX = genesisOrd != null ? x(genesisOrd) : 6;   // 创世基准 = 虚拟时刻坐标；全库无时刻时贴左缘
  // 创世**逐条虚拟时刻**（第 74 轮）：默认视图尺度下先按半箱避让排开（右缘齐基准、逐张左让），
  // 再把最终 px 反解成各自的虚拟时刻——每条创世有自己的虚拟时间；顺序 = 时间序 → 首字母序。
  const genV = new Map();
  if (genesisOrd != null && earliestOrd != null && width > 0) {
    const genList = flagItems.filter((i) => i.genesis);
    if (genList.length) {
      const spanD = full.hi - full.lo;
      const pxA = ((genesisOrd - full.lo) / spanD) * width;
      const lw = genList.map((it) => wOf(it.title, it.path));
      const left = genList.map((it, i) => pxA - lw[i]);       // 初始：右缘齐基准
      for (let i = genList.length - 2; i >= 0; i--) {
        const need = left[i + 1] - lw[i] / 2 - GAP;           // 半箱避让（与级联同式）
        if (left[i] > need) left[i] = need;
      }
      genList.forEach((it, i) => genV.set(it.path, full.lo + (left[i] / width) * spanD));
    }
  }
  for (const it of flagItems) {
    it._w = wOf(it.title, it.path);
    it._trueX = it.genesis
      ? (genV.has(it.path) ? x(genV.get(it.path)) : (genesisX - it._w))   // 创世 = 各自虚拟时刻（genV 存序数 → x() 转像素）
      : x(it.s);                                                          // 普通卡 = 真实时刻
    it._left = it._trueX;
  }
  // 高度：道数/形态读 --chrono-h 目标值（与 tall 判定同源；过渡中的 clientHeight 会分段跳变）
  const COMPACT = chronoH < COMPACT_H;
  const maxLanes = Math.max(1, Math.floor((chronoH - 26 - FLAG_H) / (FLAG_H + LANE_GAP)) + 1);   // 高：允许重叠卡片分道
  const chain = flagItems.filter((it) => it.path !== currentPath);   // 打开中的卡片恒在最上，不参与堆叠位移

  // ── 分道 first-fit：找最低的道「其末卡左半 + GAP 不越过本卡真实位置」；全满 → 重叠最小之道兜底
  const laneLast = new Array(maxLanes).fill(null);
  for (const it of chain) {
    let L = -1;
    for (let j = 0; j < maxLanes; j++) {
      const last = laneLast[j];
      if (!last || last._trueX + last._w / 2 + GAP <= it._trueX) { L = j; break; }
    }
    if (L < 0) {
      let best = 0, bestOv = Infinity;
      for (let j = 0; j < maxLanes; j++) {
        const last = laneLast[j];
        const ov = last ? Math.max(0, last._trueX + last._w / 2 + GAP - it._trueX) : 0;
        if (ov < bestOv) { bestOv = ov; best = j; }
      }
      L = best;
    }
    it._lane = L;
    laneLast[L] = it;
  }

  // ── 聚合簇（三类互斥、类内全并）：① 创世 ② 打开条目左侧 ③ 右侧；跨类不并，
  //    类内满足「同道 + 相邻左缘 < CLUSTER_GAP + ≥ MIN_CLUSTER 张」即可并；打开卡是参照点、永不参与
  const openOrd = flagItems.find((it) => it.path === currentPath)?.s ?? null;
  const clsOf = (it) => (it.genesis ? 1 : (openOrd != null && it.s < openOrd ? 2 : 3));
  const clusterable = (it) => it.path !== currentPath;
  const laneMembers = new Map();
  for (const it of chain) {
    if (!laneMembers.has(it._lane)) laneMembers.set(it._lane, []);
    laneMembers.get(it._lane).push(it);
  }
  const mergedPaths = new Set();
  const clusters = [];
  for (const grp of laneMembers.values()) {
    let i = 0;
    while (i < grp.length) {
      if (!clusterable(grp[i])) { i++; continue; }
      let j = i + 1;
      // 段延续 = 同类（clsOf 相等即天然断在类别边界，含打开卡两侧）+ 左缘间距达标（逐条虚拟后创世左缘即 v）
      while (j < grp.length && clusterable(grp[j])
             && Math.abs(grp[j]._trueX - grp[j - 1]._trueX) < CLUSTER_GAP
             && clsOf(grp[j]) === clsOf(grp[j - 1])) j++;
      const run = grp.slice(i, j);
      if (run.length >= MIN_CLUSTER) {
        const first = run[0], last = run[run.length - 1];
        const isGen = !!first.genesis;
        const cl = {
          ...first,
          path: first.path,                    // 元素复用键 = 首成员
          cluster: run,
          flag: isGen ? (first.flag || (zh ? '创世' : 'GENESIS'))   // 创世簇眉题=创世（&t 创世无 &f 时兜底，第 91 轮）；余为「同时」
                       : (zh ? '同时' : 'SAME'),
          title: zh ? `＋${run.length} 条` : `+${run.length}`,
          s: isGen ? (genesisOrd ?? first.s ?? last.s)   // 创世簇 = 虚拟时刻（点击取景不再飞到前 9999）
                   : ((first.s != null && last.s != null) ? (first.s + last.s) / 2 : (first.s ?? last.s ?? earliestOrd)),   // 普通簇 = 成员中心
          e: null, instant: true,
          fuzzy: run.some((m) => m.fuzzy),
          genesis: isGen,                      // 创世簇保持创世身份（尾箭头/互避链照常）
        };
        cl._lane = first._lane;
        cl._w = wOf(cl.title, cl.path);   // 簇卡实测（元素复用键 = 首成员；成形首帧退回基准宽，尾随重算收敛）
        cl._trueX = isGen ? genesisX - cl._w : x(cl.s);   // 创世簇同创世锚定规则
        cl._left = cl._trueX;
        clusters.push(cl);
        for (const m of run) mergedPaths.add(m.path);
      }
      i = j;
    }
  }
  const arrange = [...flagItems.filter((it) => !mergedPaths.has(it.path)), ...clusters];
  // z 序 = 时间序，簇按中心时刻参与排名（第 72 轮：合并为簇的也要比左边的图层高，因为它的时间晚）
  // 上限压到 OPEN_Z−1（第 75 轮压力测试：条目 >70 时 10+rank 会越过 80，把"打开卡恒最上"打破；
  //  ≤70 条时与旧行为逐位一致；超出部分同 z 并列，靠 DOM 顺序（时间序）在同层内兜底）
  arrange.slice().sort(cmpTime).forEach((it, i) => { it._z = Math.min(BASE_Z + i, OPEN_Z - 1); });

  // ── 让位：同道内级联——「左 1/2 检测箱」，后卡只可压前卡右半；不撞左半零位移、无上限（半箱是硬保证）
  const laneArrange = new Map();
  for (const it of arrange) {
    if (it.path === currentPath) continue;      // 打开中的卡片贴轴，不参与堆叠位移
    if (it._lane == null) continue;
    if (!laneArrange.has(it._lane)) laneArrange.set(it._lane, []);
    laneArrange.get(it._lane).push(it);
  }
  for (const grp of laneArrange.values()) {
    grp.sort((a, b) => a._trueX - b._trueX);   // 簇对象 append 在末尾会错乱链序 → 按时间位置排序再级联
    for (let i = grp.length - 2; i >= 0; i--) {
      const cur = grp[i], nxt = grp[i + 1];
      const need = nxt._left - cur._w / 2 - GAP;                     // 露左半（创世卡同规则）
      if (cur._left > need) cur._left = need;
    }
  }

  // ── 打开中的卡片参与碰撞：恒 z80 贴轴，但与其他卡片互不遮挡
  //    A) O 是创世 → 按虚拟时刻相对 O 分两侧：早于 O 向左链、晚于 O 贴 O 右缘（零间距，链内半箱）
  //    B) O 非创世且盖到创世卡左半 → O 右移越过（创世恒可见优先）
  //    C) 纵向带与 O 相交的各道：被 O 盖住左半的卡片链式左让、晚于 O 的右链贴 O 右缘（零间距）
  const genItems = arrange.filter((it) => it.genesis);
  const openIt = arrange.find((it) => it.path === currentPath);
  if (openIt) {
    const oH = (openSize && openSize.h) || (COMPACT ? OPEN_H_COMPACT : OPEN_H);
    const oRealW = openSize && openSize.w ? openSize.w : openIt._w;
    // 卡片在 .chrono-canvas（inset 0 0 28px）内定位：贴轴卡底边 = 画布底 −6（画布 = 面板 −28）
    const oTop = (chronoH - 28) - 6 - oH;
    if (openIt.genesis && genItems.length > 1) {
      const oLg = openIt._left;
      const oRg = openIt._left + oRealW;
      const others = genItems.filter((x) => x !== openIt).slice().sort((a, b) => a._trueX - b._trueX);
      let li = -1;
      for (let i = 0; i < others.length; i++) if (others[i]._trueX < openIt._trueX) li = i;   // 最后一个虚拟位置在 O 之前的
      for (let i = li; i >= 0; i--) {                    // 左侧：自右向左链式
        const cur = others[i];
        const nxt = i === li ? { _left: oLg, _w: openIt._w } : others[i + 1];
        const need = nxt._left - cur._w / 2 - GAP;
        if (cur._left > need) cur._left = need;
      }
      let block = oRg;                                  // 右侧：自左向右，首位贴 O 右缘（零间距）
      for (let i = li + 1; i < others.length; i++) {
        const cur = others[i];
        if (cur._left < block) cur._left = block;
        block = cur._left + cur._w / 2 + GAP;
      }
    } else if (genItems.length && !openIt.genesis) {
      for (let it2 = 0; it2 < O_SHIFT_PASS; it2++) {      // O 右移越过被压的创世卡（循环至稳定）
        let need = openIt._left;
        for (const g of genItems) {
          if (g._left < openIt._left + openIt._w && g._left + g._w / 2 + GAP > openIt._left) need = Math.max(need, g._left + g._w / 2 + GAP);
        }
        if (need === openIt._left) break;
        openIt._left = need;
      }
    }
    const oR = openIt._left + oRealW;   // 实测宽（右侧贴齐用）
    for (const [lane, grp] of laneArrange) {
      if (10 + lane * (FLAG_H + LANE_GAP) + oH - oTop <= 10) continue;   // 带状不相交（相邻道叠片 ≤10px 属设计）→ 不干涉
      const grpC = grp.filter((x) => !x.genesis);                // 创世卡不在此让位（A/B 已保证不与 O 互遮）
      const covered = (cur) => cur._left < oR && cur._left + cur._w / 2 + GAP > openIt._left;
      // 不晚于 O 的卡片：向左链式让位（自右向左）
      for (let i = grpC.length - 1; i >= 0; i--) {
        const cur = grpC[i];
        if (cur._trueX > openIt._trueX) continue;
        let target = cur._left;
        if (covered(cur)) target = Math.min(target, openIt._left - cur._w / 2 - GAP);
        const nxt = i === grpC.length - 1 ? null : grpC[i + 1];
        if (nxt && nxt._trueX <= openIt._trueX && nxt._left < cur._left + cur._w / 2 + GAP) target = Math.min(target, nxt._left - cur._w / 2 - GAP);
        if (target < cur._left) cur._left = target;
      }
      // 晚于 O 的卡片：向右链式让位（保持时间次序）——右侧不留间距，紧贴打开卡右缘
      let blockUntil = oR;
      for (let i = 0; i < grpC.length; i++) {
        const cur = grpC[i];
        if (cur._trueX <= openIt._trueX) continue;
        if (cur._left < blockUntil) cur._left = blockUntil;
        blockUntil = cur._left + cur._w / 2 + GAP;
      }
    }
  }
  // 创世向左渐隐箭头：跟组左缘；组左缘已出屏（或整组出屏）时隐藏——箭头只标"组的左端在哪"
  let tail = { hidden: true, left: 0, top: 0 };
  if (genItems.length) {
    let mnT = Infinity, minTop = Infinity;
    for (const it of genItems) {
      mnT = Math.min(mnT, it._left);
      const pt = it.cluster ? undefined : prevTops[it.path];   // 簇对象每帧新建 → 旧管线中其 _top 恒为 undefined
      minTop = Math.min(minTop, typeof pt === 'number' ? pt : LANE_TOP);
    }
    tail = {
      hidden: !(mnT > 6),
      left: Math.max(2, mnT - 26),
      top: minTop + FLAG_H / 2 - 6,
    };
  }
  // 出界指示：完全在视口外的卡片数（按放置位置；簇计入、创世随虚拟时刻）
  let offL = 0, offR = 0, nearL = null, nearR = null;
  for (const it of arrange) {
    if (it._left + it._w < EDGE_MARGIN) { offL++; if (!nearL || it._trueX > nearL._trueX) nearL = it; }
    else if (it._left > width - EDGE_MARGIN) { offR++; if (!nearR || it._trueX < nearR._trueX) nearR = it; }
  }
  const ordOf = (it) => (it.genesis ? (genV.get(it.path) ?? genesisOrd) : it.s);   // 创世取该条目自己的虚拟时刻，勿传真实 -9999
  const hints = {
    offL, offR,
    ordL: nearL ? ordOf(nearL) : null,
    ordR: nearR ? ordOf(nearR) : null,
  };

  // ── 最终放置：top（打开卡贴轴）/ z / 显示字段
  const placements = arrange.map((it) => {
    const lane = it._lane == null ? 0 : it._lane;
    const isOpen = it.path === currentPath;
    let cluster = null;
    if (it.cluster) {
      const last = it.cluster[it.cluster.length - 1];
      const memberTitles = it.cluster.map((m) => m.title);
      cluster = {
        ord: it.s,   // 普通簇 = 成员中心；创世簇 = 虚拟时刻
        // 取景跨度：普通簇 = 成员跨度 × CLUSTER_SPAN_X（≥1 年）；创世簇 = 全范围 × GENESIS_SPAN（成员同刻跨度为 0，深缩会把轴首推出屏外）
        spanYears: it.cluster[0].genesis
          ? Math.max(((full.hi - full.lo) / YEAR) * GENESIS_SPAN, 1)
          : Math.max(((last.s - it.cluster[0].s) / YEAR) * CLUSTER_SPAN_X, 1),
        altTitle: memberTitles.slice(0, 3).join('、') + (memberTitles.length > 3 ? '…' : ''),
        memberTitles,
      };
    }
    return {
      path: it.path, left: it._left, trueX: it._trueX, w: it._w, lane,
      top: isOpen ? 'axis' : LANE_TOP + lane * (FLAG_H + LANE_GAP),
      z: isOpen ? OPEN_Z : it._z,
      isOpen,
      eyebrow: it.cluster ? it.flag : (flags[it.path] || it.flag || ''),
      title: it.title, date: it.start, fuzzy: !!it.fuzzy,
      cluster,
    };
  });

  // ── 覆盖条：本书 items 全部非创世条目（复用既有元素由 world.js 负责）
  const spans = [];
  for (const it of items) {
    if (it.genesis) continue;   // 创世条目无覆盖条（不按 &s 生效）
    const sx = x(it.s);
    const ex = it.e != null ? x(it.e) : sx;
    const w = Math.max(ex - sx, it.instant ? 0 : 6);
    // 模糊 = 按端渐隐：数据层 fuzzyS/fuzzyE 字段优先（第 76 轮单点真相），缺字段回退原文串解析（兼容旧夹具）
    spans.push({
      path: it.path, left: sx, width: w,
      fuzzyS: !!(it.fuzzyS ?? String(it.start || '').includes('*')),
      fuzzyE: !it.instant && !!(it.fuzzyE ?? String(it.end || '').includes('*')),
      isOpen: it.path === currentPath,
      title: `${it.title} · ${it.start}${it.end && !it.instant ? ' → ' + it.end : ''}`,
    });
  }

  // ── 时代带：同 &a 条目的时间并集，bg/bg-soft 交替（跳过出屏带也占位 → 交替稳定）
  const eraMap = new Map();
  for (const it of items) {
    if (!it.era || it.s == null) continue;
    const e2 = eraMap.get(it.era);
    if (e2) { e2.lo = Math.min(e2.lo, it.s); e2.hi = Math.max(e2.hi, it.e ?? it.s); }
    else eraMap.set(it.era, { era: it.era, lo: it.s, hi: it.e ?? it.s });
  }
  const eras = [];
  let eraIdx = 0;
  for (const e2 of [...eraMap.values()].sort((a, b) => a.lo - b.lo)) {
    const x1 = x(e2.lo), x2 = x(e2.hi);
    if (x2 < -ERA_PAD || x1 > width + ERA_PAD) { eraIdx++; continue; }
    eras.push({
      name: e2.era, left: x1, width: Math.max(ERA_MIN_W, x2 - x1),
      alt: eraIdx % 2 === 1, showName: x2 - x1 > ERA_NAME_MIN,
      lo: e2.lo, hi: e2.hi,
    });
    eraIdx++;
  }

  // ── 轴线段：只画 [最早时间, 最晚时间] 与视口的交集（范围外含创世区无线）
  let axis = { hidden: true, left: 0, width: 0 };
  if (earliestOrd != null) {
    const ax1 = Math.max(0, x(earliestOrd)), ax2 = Math.min(width, x(latestOrd));
    axis = { hidden: ax2 <= ax1, left: Math.round(ax1), width: Math.round(Math.max(0, ax2 - ax1)) };
  }

  return { compact: COMPACT, placements, spans, ticks, markers, eras, axis, hints, tail };
}
