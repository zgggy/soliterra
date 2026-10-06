// 第 75 轮：时间轴布局引擎测试台（node --test，零依赖；`npm test` / `node --test test/`）
// 三层：① golden 快照重放（行为冻结，旧管线等价验证后捕获）② 不变量（半箱/z 序/聚簇/创世序/出界/模糊/刻度）
//       ③ 压力合成（随机密度 × 四高度 × 缩放档——把"从未被真实密度压测"变成可复跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeLayout, LAYOUT, YEAR } from '../public/js/timeline-layout.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(readFileSync(join(__dir, 'fixtures/golden.json'), 'utf8'));
const TOL = 0.6;   // 浮点容差（与浏览器校验器同款）

/** 期望 ⊆ 实际 的递归比较：fixture 记录的字段必须一致（数值带容差；实际多出的新字段不算差异）。 */
function cmpSub(exp, act, at, out) {
  if (out.length >= 10) return;
  if (typeof exp === 'number') {
    if (typeof act !== 'number' || Math.abs(exp - act) > TOL) out.push(`${at}: 期望 ${exp} 实际 ${act}`);
    return;
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(act) || act.length !== exp.length) { out.push(`${at}.length: 期望 ${exp.length} 实际 ${act && act.length}`); return; }
    exp.forEach((v, i) => cmpSub(v, act[i], `${at}[${i}]`, out));
    return;
  }
  if (exp && typeof exp === 'object') {
    if (!act || typeof act !== 'object') { out.push(`${at}: 期望对象 实际 ${JSON.stringify(act)}`); return; }
    for (const k of Object.keys(exp)) cmpSub(exp[k], act[k], `${at}.${k}`, out);
    return;
  }
  if (exp !== act) out.push(`${at}: 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(act)}`);
}

function byPathOf(input) {
  const m = new Map(input.items.map((i) => [i.path, i]));
  for (const g of input.genesisAll) m.set(g.path, g);
  return m;
}

/** 竖直带 + 盒宽（打开卡贴轴 = [oTop, oTop+oH]，盒宽取**实测宽**（渲染真相，与引擎 oR 同款）；
 *  非打开卡 = [top, top+FLAG_H]，盒宽取引擎基准宽（≥ 渲染自然宽 → 保守偏严））。 */
function boxesOf(input, frame) {
  const oH = (input.openSize && input.openSize.h) || (frame.compact ? LAYOUT.OPEN_H_COMPACT : LAYOUT.OPEN_H);
  const oTop = (input.chronoH - 28) - 6 - oH;
  return frame.placements.map((p) => (p.top === 'axis'
    ? { p, lo: oTop, hi: oTop + oH, w: (input.openSize && input.openSize.w) || p.w }
    : { p, lo: p.top, hi: p.top + LAYOUT.FLAG_H, w: p.w }));
}

/** 不变量全套（半箱 / z 序 / 道 / 簇 / 创世序 / 出界 / 跨度 / 刻度 / 标记 / 尾箭头 / 轴线 / compact）。返回违例列表。 */
function checkInvariants(input, frame) {
  const out = [];
  const byPath = byPathOf(input);
  const x = (ord) => ((ord - input.view.lo) / (input.view.hi - input.view.lo)) * input.width;
  const H = LAYOUT.FLAG_H;

  // ① 半箱：任意「高 z 卡」不得侵入「低 z 卡」左半（带状重叠 > 10px 才算干涉；水平须真重叠；
  //    可见性保证 = 左半（中点），GAP 是让位量、不属可见性保证 → 判据取中点）
  const bs = boxesOf(input, frame);
  for (const a of bs) for (const b of bs) {
    if (a.p === b.p || !(a.p.z < b.p.z)) continue;
    if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) <= 10) continue;
    const overlapX = b.p.left + b.w > a.p.left + TOL;
    const intrudes = b.p.left < a.p.left + a.w / 2 - TOL;
    if (overlapX && intrudes) out.push(`半箱违例: ${b.p.path}(z${b.p.z}) 压 ${a.p.path}(z${a.p.z}) 左半 [b.left=${b.p.left.toFixed(1)} a.mid=${(a.p.left + a.w / 2).toFixed(1)}]`);
  }
  // ② z 序 = 时间序（簇按中心 ord 参与排名；打开卡恒 OPEN_Z 且为全场最大）
  const keyed = frame.placements.map((p) => ({ p, s: p.cluster ? p.cluster.ord : byPath.get(p.path)?.s ?? null }));
  const sorted = [...keyed].sort((a, b) => ((a.s ?? -Infinity) - (b.s ?? -Infinity)) || String(a.p.title).localeCompare(String(b.p.title), 'zh-Hans-CN'));
  sorted.forEach((k, i) => {
    const want = k.p.top === 'axis' ? LAYOUT.OPEN_Z : Math.min(LAYOUT.BASE_Z + i, LAYOUT.OPEN_Z - 1);
    if (k.p.z !== want) out.push(`z 序: ${k.p.path} 期望 ${want} 实际 ${k.p.z}`);
  });
  const openP = frame.placements.filter((p) => p.top === 'axis');
  for (const op of openP) {
    for (const q of frame.placements) if (q !== op && q.z >= op.z) out.push(`打开卡非最上: ${q.path} z=${q.z} ≥ 打开卡 z=${op.z}`);
  }
  // ③ 道与 top
  if (frame.compact !== (input.chronoH < LAYOUT.COMPACT_H)) out.push('compact 判定不符');
  const maxLanes = Math.max(1, Math.floor((input.chronoH - 26 - H) / (H + LAYOUT.LANE_GAP)) + 1);
  for (const p of frame.placements) {
    if (p.top === 'axis') { if (p.z !== LAYOUT.OPEN_Z) out.push(`打开卡 z 非 OPEN_Z: ${p.path}`); continue; }
    if (p.lane < 0 || p.lane >= maxLanes) out.push(`道号越界 ${p.path} lane=${p.lane} max=${maxLanes}`);
    const wantTop = LAYOUT.LANE_TOP + p.lane * (H + LAYOUT.LANE_GAP);
    if (Math.abs(p.top - wantTop) > TOL) out.push(`top 与道号不符 ${p.path}: ${p.top} ≠ ${wantTop}`);
  }
  // ④ 簇：成员数 / 取景跨度 / 中心时刻（普通簇 ∈ 成员时刻区间；创世簇 = genesisOrd）
  for (const p of frame.placements) {
    if (!p.cluster) continue;
    const c = p.cluster;
    if (c.memberTitles.length < LAYOUT.MIN_CLUSTER) out.push(`簇成员不足: ${p.path} ${c.memberTitles.length}`);
    if (!(c.spanYears >= 1 - 1e-9)) out.push(`簇取景跨度 < 1 年: ${p.path} ${c.spanYears}`);
    const members = [...byPath.values()].filter((i) => c.memberTitles.includes(i.title));
    if (!members.length) { out.push(`簇成员匹配不到输入: ${p.path}`); continue; }
    const isGen = members.every((m) => m.genesis);
    if (isGen) {
      if (input.genesisOrd != null && Math.abs(c.ord - input.genesisOrd) > TOL) out.push(`创世簇 ord ≠ genesisOrd: ${p.path}`);
    } else {
      const ss = members.map((m) => m.s).filter((v) => v != null);
      if (ss.length && (c.ord < Math.min(...ss) - TOL || c.ord > Math.max(...ss) + TOL)) out.push(`普通簇中心越界: ${p.path} ${c.ord}`);
    }
  }
  // ⑤ 创世逐条虚拟时刻：非簇创世卡的 trueX（虚拟时刻坐标）顺序 = (s, 标题) 顺序
  //    （left 会被分道级联/O 通道合法推移 → 只查 trueX；px 单调 = 序数单调）
  const genSolo = frame.placements.filter((p) => !p.cluster && byPath.get(p.path)?.genesis);
  if (genSolo.length > 1) {
    const byLeft = [...genSolo].sort((a, b) => a.trueX - b.trueX).map((p) => p.path).join('|');
    const byKey = [...genSolo].sort((a, b) => {
      const ia = byPath.get(a.path), ib = byPath.get(b.path);
      return ((ia.s ?? -Infinity) - (ib.s ?? -Infinity)) || String(ia.title).localeCompare(String(ib.title), 'zh-Hans-CN');
    }).map((p) => p.path).join('|');
    if (byLeft !== byKey) out.push('创世虚拟时刻顺序不符');
  }
  // ⑥ 出界计数与提示 ord
  let offL = 0, offR = 0;
  for (const p of frame.placements) {
    if (p.left + p.w < LAYOUT.EDGE_MARGIN) offL++;
    else if (p.left > input.width - LAYOUT.EDGE_MARGIN) offR++;
  }
  if (frame.hints.offL !== offL || frame.hints.offR !== offR) out.push(`出界计数: ${frame.hints.offL}/${frame.hints.offR} ≠ ${offL}/${offR}`);
  if ((frame.hints.offL > 0) !== (frame.hints.ordL != null)) out.push('hintL ord 与计数不符');
  if ((frame.hints.offR > 0) !== (frame.hints.ordR != null)) out.push('hintR ord 与计数不符');
  // ⑦ 覆盖条：几何 = x(s)→x(e)，宽度 ≥ instant?0:6，逐端模糊 = 原文串 *
  const expectSpans = input.items.filter((i) => !i.genesis).length;
  if (frame.spans.length !== expectSpans) out.push(`覆盖条数量: ${frame.spans.length} ≠ ${expectSpans}`);
  for (const s of frame.spans) {
    const it = byPath.get(s.path);
    if (!it) { out.push(`覆盖条无对应条目: ${s.path}`); continue; }
    if (Math.abs(s.left - x(it.s)) > TOL) out.push(`覆盖条 left: ${s.path}`);
    if (s.width < (it.instant ? 0 : 6) - TOL) out.push(`覆盖条宽 < 最小值: ${s.path} ${s.width}`);
    // 逐端模糊：引擎契约 = 字段优先（第 76 轮数据层），缺字段回退原文串
    if (s.fuzzyS !== !!(it.fuzzyS ?? String(it.start || '').includes('*'))) out.push(`覆盖条 fuzzyS: ${s.path}`);
    if (s.fuzzyE !== (!it.instant && !!(it.fuzzyE ?? String(it.end || '').includes('*')))) out.push(`覆盖条 fuzzyE: ${s.path}`);
  }
  // ⑧ 刻度升序 + 余量；刻度让位标记；标记余量
  let prev = -Infinity;
  for (const t of frame.ticks) {
    if (!(t.px > prev)) out.push(`刻度非升序: ${t.px} ≤ ${prev}`);
    prev = t.px;
    if (t.px < -LAYOUT.TICK_PAD - TOL || t.px > input.width + LAYOUT.TICK_PAD + TOL) out.push(`刻度出余量: ${t.px}`);
  }
  for (const m of frame.markers) {
    if (m.px < -LAYOUT.MARKER_PAD - TOL || m.px > input.width + LAYOUT.MARKER_PAD + TOL) out.push(`标记出余量: ${m.px}`);
    for (const t of frame.ticks) if (Math.abs(t.px - m.px) < LAYOUT.TICK_MARKER_GAP - TOL) out.push('刻度未让位标记');
  }
  // ⑨ 尾箭头 / 轴线
  const genAll = frame.placements.filter((p) => byPath.get(p.path)?.genesis);
  if (!genAll.length) { if (!frame.tail.hidden) out.push('尾箭头应隐藏（无创世）'); }
  else {
    const mn = Math.min(...genAll.map((p) => p.left));
    if (frame.tail.hidden !== !(mn > 6)) out.push('尾箭头显隐不符');
    if (!frame.tail.hidden && Math.abs(frame.tail.left - Math.max(2, mn - 26)) > TOL) out.push('尾箭头 left 不符');
  }
  if (input.earliestOrd == null) { if (!frame.axis.hidden) out.push('轴线应隐藏'); }
  else {
    const ax1 = Math.max(0, x(input.earliestOrd)), ax2 = Math.min(input.width, x(input.latestOrd));
    if (frame.axis.hidden !== (ax2 <= ax1)) out.push('轴线显隐不符');
    if (Math.abs(frame.axis.left - Math.round(ax1)) > TOL) out.push('轴线 left 不符');
    if (Math.abs(frame.axis.width - Math.round(Math.max(0, ax2 - ax1))) > TOL) out.push('轴线 width 不符');
  }
  return out;
}

// ── ① golden 快照重放 ────────────────────────────────────────────────
test('golden 快照：12 帧逐字段一致（行为冻结）', () => {
  assert.ok(GOLDEN.frames.length >= 12, 'golden 帧数不足');
  for (const f of GOLDEN.frames) {
    const frame = computeLayout(f.input);
    const out = [];
    cmpSub(f.frame, frame, f.label, out);
    assert.equal(out.length, 0, `${f.label} 差异:\n${out.join('\n')}`);
  }
});

test('golden 快照：不变量全绿', () => {
  for (const f of GOLDEN.frames) {
    const out = checkInvariants(f.input, f.frame);
    assert.equal(out.length, 0, `${f.label} 违例:\n${out.join('\n')}`);
  }
});

// ── ③ 压力合成 ──────────────────────────────────────────────────────
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function synthWorld(n, seed) {
  const rnd = lcg(seed);
  const titles = ['北伐', '血色婚礼', '废奴', '灵矿航道之乱', '大崩坏', '卡德伦编年史', '银湾', '绯红能源', '勘误演示', '甲', '乙丙丁', '长标题试验条目'];
  const items = [];
  for (let i = 0; i < n; i++) {
    const y = Math.floor(rnd() * 800) + 1;
    const instant = rnd() < 0.5;
    const fuzzy = rnd() < 0.3;
    const s = y * YEAR + Math.floor(rnd() * 12) * 30.44 + Math.floor(rnd() * 28);
    const e = instant ? null : s + Math.floor(rnd() * 60) * 30.44;
    const bucket = rnd() < 0.25 ? Math.floor(s / (30.44 * 3)) : null;   // 1/4 概率把时间吸附到三个月桶 → 制造同刻/近刻簇
    items.push({
      path: `书/条目${i}.md`, title: titles[i % titles.length],
      s: bucket != null ? bucket * 30.44 * 3 : s,
      e: instant ? null : (bucket != null ? bucket * 30.44 * 3 + 365.25 : e),
      start: `${y}.01.01`, end: instant ? null : `${y + 1}.01.01`,
      instant, fuzzy, flag: '事件', era: null, genesis: false,
    });
  }
  const genesisAll = ['阿莱亚', '塞勒玛', '叹息之境'].map((t2, i) => ({
    path: `溯源/${t2}.md`, title: t2, s: -9999 * YEAR - i, e: null, start: '-9999.*.*', end: null,
    instant: true, fuzzy: true, flag: '创世', era: null, genesis: true,
  }));
  return { items, genesisAll };
}

function runStress(n, seed, label) {
  const { items, genesisAll } = synthWorld(n, seed);
  const times = items.map((i) => i.s).filter((v) => v != null);
  const lo = Math.min(...times), hi = Math.max(...times) + YEAR;
  const heights = [70, 112, 200, 520, 900];
  const zoom = [1, 0.3, 3, 20];
  const openPath = items[Math.floor(n / 3)]?.path || null;
  const flags = {};
  for (const i of items) flags[i.path] = i.flag;
  for (const g of genesisAll) flags[g.path] = g.flag;
  const full = { lo: lo - (hi - lo) * 0.05, hi: hi + (hi - lo) * 0.05 };
  const genesisOrd = lo - ((hi - lo) * 0.01 || YEAR);
  let frames = 0;
  for (const h of heights) {
    for (const k of zoom) {
      const c = (lo + hi) / 2;
      const span = (full.hi - full.lo) * k;
      const input = {
        items, genesisAll, flags,
        view: { lo: c - span / 2, hi: c + span / 2 }, full,
        width: 1280, chronoH: h, lang: 'zh-CN', currentPath: openPath,
        genesisOrd, earliestOrd: lo, latestOrd: hi,
        openSize: k === 1 && h === 112 ? { w: 78, h: 64 } : null,   // 混合有无实测尺寸
        prevTops: Object.fromEntries(items.slice(0, 10).map((i) => [i.path, 10 + (i.path.length % 3) * 58])),
      };
      const frame = computeLayout(input);
      const out = checkInvariants(input, frame);
      assert.equal(out.length, 0, `${label} h=${h} k=${k} 违例:\n${out.slice(0, 6).join('\n')}`);
      // 确定性：同输入两跑结果一致
      const frame2 = computeLayout(input);
      assert.equal(JSON.stringify(frame), JSON.stringify(frame2), `${label} h=${h} k=${k} 非确定性`);
      frames++;
    }
  }
  return frames;
}

test('压力合成：200 条 × 五高度 × 四缩放 不变量全绿', () => {
  const frames = runStress(200, 20261006, '密度200');
  assert.ok(frames >= 20);
});

test('压力合成：500 条 × 五高度 × 四缩放 不变量全绿', () => {
  const frames = runStress(500, 987654321, '密度500');
  assert.ok(frames >= 20);
});

test('边界：空世界 / 无时刻 / 仅创世 / 无打开卡 不抛异常且不变量成立', () => {
  const empty = { items: [], genesisAll: [], flags: {}, view: { lo: 0, hi: 1 }, full: { lo: 0, hi: 1 }, width: 1280, chronoH: 112, lang: 'zh-CN', currentPath: null, genesisOrd: null, earliestOrd: null, latestOrd: null, openSize: null, prevTops: {} };
  const f1 = computeLayout(empty);
  assert.equal(f1.placements.length, 0);
  assert.equal(checkInvariants(empty, f1).length, 0);
  const onlyGen = { ...empty, genesisAll: [{ path: 'a.md', title: '甲', s: -9999 * YEAR, e: null, start: '-9999.*.*', end: null, instant: true, fuzzy: true, flag: '创世', era: null, genesis: true }], flags: { 'a.md': '创世' }, currentPath: 'a.md', genesisOrd: -1e6, earliestOrd: 0, latestOrd: 100 * YEAR };
  const f2 = computeLayout(onlyGen);
  assert.equal(checkInvariants(onlyGen, f2).length, 0);
  assert.equal(f2.placements[0].top, 'axis');   // 打开创世 → 贴轴
});

// ── 第 76 轮：实测宽（碰撞箱 = 渲染箱）与 fuzzy 数据层字段 ────────────
const baseInput = (extra = {}) => ({
  items: [
    { path: 'a.md', title: '甲', s: 1000, e: null, start: '0003.01.01', end: null, instant: true, fuzzy: false, flag: '事件', era: null, genesis: false },
    { path: 'b.md', title: '乙', s: 1050, e: null, start: '0003.01.01', end: null, instant: true, fuzzy: false, flag: '事件', era: null, genesis: false },
  ],
  genesisAll: [], flags: { 'a.md': '事件', 'b.md': '事件' },
  view: { lo: 0, hi: 2000 }, full: { lo: 0, hi: 2000 },
  width: 1000, chronoH: 112, lang: 'zh-CN', currentPath: null,
  genesisOrd: null, earliestOrd: 1000, latestOrd: 1050,
  openSize: null, prevTops: {}, measuredW: {},
  ...extra,
});

test('实测宽：碰撞箱取 min(实测, 基准宽) —— 短卡不再多让（级联位置随之变化）', () => {
  const base = baseInput();
  const fp = computeLayout(base);
  const a0 = fp.placements.find((p) => p.path === 'a.md');
  const b0 = fp.placements.find((p) => p.path === 'b.md');
  // 基准宽 36（1 字）：need = 525 − 18 − 10 = 497
  assert.ok(Math.abs(a0.left - 497) < 0.6, `基准宽下 a.left=${a0.left}`);
  assert.equal(b0.w, 36);
  // 实测 30：need = 525 − 15 − 10 = 500
  const fp2 = computeLayout(baseInput({ measuredW: { 'a.md': 30 } }));
  const a1 = fp2.placements.find((p) => p.path === 'a.md');
  assert.ok(Math.abs(a1.left - 500) < 0.6, `实测宽下 a.left=${a1.left}`);
  assert.equal(a1.w, 30);
  // 实测大于基准（长标题被 4 字上限截断）→ 仍取基准宽
  const fp3 = computeLayout(baseInput({ measuredW: { 'a.md': 200 } }));
  assert.equal(fp3.placements.find((p) => p.path === 'a.md').w, 36);
  // 不变量在两种口径下都成立
  assert.equal(checkInvariants(base, fp).length, 0);
  assert.equal(checkInvariants(baseInput({ measuredW: { 'a.md': 30 } }), fp2).length, 0);
});

test('fuzzy 数据层：字段优先、缺字段回退原文串（逐端语义）', () => {
  const mk = (row) => ({ ...baseInput().items[0], path: row.path, start: row.start, end: row.end, instant: !!row.instant, fuzzyS: row.fuzzyS, fuzzyE: row.fuzzyE });
  const input = baseInput();
  input.items = [
    mk({ path: 'x.md', start: '0800.*.*', end: '0801.01.01', instant: false, fuzzyS: true, fuzzyE: false }),     // 字段：只有起端模糊（即使串里有 *）
    mk({ path: 'y.md', start: '0800.01.01', end: '0801.*.01', instant: false, fuzzyS: false, fuzzyE: true }),     // 字段：只有止端模糊
    mk({ path: 'z.md', start: '0802.*.*', end: null, instant: true }),                                            // 缺字段（旧夹具形状）→ 回退串解析
  ];
  input.items[0].s = 800 * YEAR; input.items[1].s = 800.2 * YEAR; input.items[2].s = 802 * YEAR;
  input.flags = { 'x.md': '事件', 'y.md': '事件', 'z.md': '事件' };
  input.earliestOrd = 800 * YEAR; input.latestOrd = 802 * YEAR;
  const fr = computeLayout(input);
  const sp = (p2) => fr.spans.find((s) => s.path === p2);
  assert.deepEqual([sp('x.md').fuzzyS, sp('x.md').fuzzyE], [true, false]);
  assert.deepEqual([sp('y.md').fuzzyS, sp('y.md').fuzzyE], [false, true]);
  assert.deepEqual([sp('z.md').fuzzyS, sp('z.md').fuzzyE], [true, false]);   // 回退：start 含 * 且 instant → 止端恒 false
  assert.equal(checkInvariants(input, fr).length, 0);
});
