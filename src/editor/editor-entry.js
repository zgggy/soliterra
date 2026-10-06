// Soliterra 简化编辑器（功能设计 §5 的 B 档：CodeMirror 6 + 装饰层）
// 装饰只改「显示」不改「字节」：粗体显字重、双链显链接蓝、& 元数据行样式化、围栏头角标、标题显字号。
// 打包：npx esbuild editor/editor-entry.js --bundle --format=esm --outfile=public/js/vendor/soliterra-editor.js

import { EditorState, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView, keymap, drawSelection, highlightActiveLine, Decoration,
  ViewPlugin, WidgetType,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language';
import { autocompletion, startCompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { foldMarks } from './editor-marks.js';   // §B.3 行内标记折叠（纯函数，node 可测）
import { containsSymbol, normalizeSymbols } from '../shared/symbols.js';   // 第 93 轮：符号规范化单点表

// ---------- 主题（design.md token） ----------
const theme = EditorView.theme({
  '&': {
    fontFamily: "var(--font-mono)",
    fontSize: '0.92rem',
    lineHeight: '1.75',
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    height: '100%',
  },
  '.cm-content': { padding: '18px 20px', caretColor: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-soft)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--bg-soft)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg-soft) 60%, transparent)' },
  '.cm-gutters': { background: 'var(--surface)', border: 'none', color: 'var(--text-muted)', fontSize: '0.7rem' },
  '.cm-meta-line': { background: 'var(--bg-soft)', fontFamily: 'var(--font-mono)', fontSize: '0.82em' },
  '.cm-wikilink': { color: 'var(--link)', textDecoration: 'underline', textDecorationOffset: '4px' },
  '.cm-fence-head': { color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: '0.78em', letterSpacing: '.08em' },
  '.cm-h1': { fontFamily: 'var(--font-serif)', fontSize: '1.6rem', fontWeight: '700', lineHeight: '1.3' },
  '.cm-h2': { fontFamily: 'var(--font-serif)', fontSize: '1.3rem', fontWeight: '700', lineHeight: '1.3' },
  '.cm-h3': { fontFamily: 'var(--font-serif)', fontSize: '1.1rem', fontWeight: '700' },
  // §B.3 块级装饰：围栏区间（左缘线+底色）· 引用左缘 · 分割线真 hairline
  '.cm-fence-body': { background: 'var(--bg-soft)', borderLeft: '1px solid var(--line)', paddingLeft: '9px' },
  '.cm-quote-line': { borderLeft: '2px solid var(--line-strong)', paddingLeft: '8px' },
  '.cm-hr-widget': { height: '1px', background: 'var(--line)', margin: '12px 0', display: 'block' },
}, { dark: false });

// 语法高亮（markdown token → design token）
const highlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-h1' },
  { tag: tags.heading2, class: 'cm-h2' },
  { tag: tags.heading3, class: 'cm-h3' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--link)' },
  { tag: tags.url, color: 'var(--text-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', background: 'var(--bg-soft)' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'var(--text-muted)' },   // ** * # 等标记弱化
  { tag: tags.contentSeparator, color: 'var(--text-muted)' },
]);

// ---------- 装饰层：& 元数据行 / [[双链]] / 围栏头 / 图片内联缩略图 ----------
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|svg)([?#]|$)/i;
const MD_IMG_RE = /!\[([^\]\n]*)\]\(([^)\s\n]+)\)/g;
const WIKI_RE = /!?\[\[([^\]\n|#]+)((?:[|#][^\]\n]*)?)\]\]/g;

/** 图片内联缩略图（§B.5）：光标不在该行时折叠原文为预览，点击 = 大图纸面。 */
/** §B.3 分割线：非光标行整行替换为真 hairline（光标行显原样可编辑）。 */
class HrWidget extends WidgetType {
  toDOM() { const d = document.createElement('div'); d.className = 'cm-hr-widget'; return d; }
  eq() { return true; }
  ignoreEvent() { return true; }
}

class ImageWidget extends WidgetType {
  constructor(url, label) { super(); this.url = url; this.label = label || ''; }
  eq(o) { return o.url === this.url && o.label === this.label; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-img-widget';
    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.label;
    img.loading = 'lazy';
    img.addEventListener('error', () => el.classList.add('err'));
    img.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.__soliterraImgClick?.(this.url, this.label);
    });
    const cap = document.createElement('span');
    cap.className = 'cm-img-cap';
    cap.textContent = this.label;
    el.appendChild(img);
    el.appendChild(cap);
    return el;
  }
  ignoreEvent() { return true; }   // 点击由 widget 自己处理（光标不进入）
}

function buildDecorations(view, resolveAsset) {
  const items = [];                       // 统一收集后排序（RangeSetBuilder 要求 from 非降序）
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const curLine = doc.lineAt(sel.head).number;
  const inSelection = (from, to) => sel.from <= to && sel.to >= from;
  let inFence = false;                     // ``` 区间状态机（§B.3.2：无条件逐行推进）

  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const text = line.text;
    const lineDeco = (cls) => items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: cls }) });

    // ── 围栏区间跟踪（§B.3.2）：状态机每行无条件跑——``` 开关行 + 区间内行 → 左缘线+底色；开关行另给头角标
    const wasIn = inFence;
    const isFenceLine = /^\s*```/.test(text);
    if (wasIn || isFenceLine) lineDeco('cm-fence-body');
    if (isFenceLine) lineDeco('cm-fence-head');
    const inCode = wasIn || isFenceLine;   // 围栏内 = 代码原文：不折叠、不染链、不当分割线/引用
    if (isFenceLine) inFence = !inFence;

    // & 元数据行（行首 &）——整行样式化（点击 = 光标就地直接编辑，第 98 轮）
    if (/^\s*&[a-z]/.test(text)) {
      lineDeco('cm-meta-line');
      continue;
    }
    const rawLine = ln === curLine;       // 光标行显原文（标记全显、图片不折叠）

    // ── 分割线（§B.3.2）：非光标行整行 replace 为真 hairline（光标行显原 --- 可编辑）
    if (!inCode && !rawLine && /^-{3,}$/.test(text.trim()) && !inSelection(line.from, line.to)) {
      items.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new HrWidget() }) });
      continue;
    }
    // ── 引用 / callout 行（§B.3.2）：左缘 2px line-strong
    if (!inCode && /^\s*>/.test(text)) lineDeco('cm-quote-line');

    if (inCode) continue;                 // 围栏内到此为止（代码原文）

    // ── 行内标记折叠（§B.3.1）：成对才藏；光标行/选区行/fence 内豁免 → 零宽 replace（字节不动）
    if (!rawLine) {
      for (const [a, b] of foldMarks(text)) {
        const from = line.from + a, to = line.from + b;
        if (to <= from) continue;
        if (inSelection(from, to)) continue;
        items.push({ from, to, deco: Decoration.replace({}) });
      }
    }

    // [[双链]] / ![[嵌入]]（图片扩展名 → 缩略图 widget）
    let m;
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      const isEmbed = m[0].startsWith('!');
      const target = m[1];
      if (isEmbed && IMG_EXT_RE.test(target)) {
        if (!rawLine && !inSelection(from, to)) {
          const url = resolveAsset ? resolveAsset(target) : target;
          items.push({ from, to, deco: Decoration.replace({ widget: new ImageWidget(url, target.split('/').pop()) }) });
        }
        continue;                          // 图片嵌入不再套链接色
      }
      if (inSelection(from, to)) continue;
      items.push({ from, to, deco: Decoration.mark({ class: 'cm-wikilink' }) });
    }
    // ![](src) 图片
    MD_IMG_RE.lastIndex = 0;
    while ((m = MD_IMG_RE.exec(text))) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (rawLine || inSelection(from, to)) continue;
      const src = m[2];
      const url = resolveAsset ? resolveAsset(src) : src;
      items.push({ from, to, deco: Decoration.replace({ widget: new ImageWidget(url, m[1] || src.split('/').pop()) }) });
    }
  }
  items.sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const builder = new RangeSetBuilder();
  for (const it of items) builder.add(it.from, it.to, it.deco);
  return builder.finish();
}

const decoPlugin = (resolveAsset) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view, resolveAsset); }
  update(u) { this.decorations = buildDecorations(u.view, resolveAsset); }
}, { decorations: (v) => v.decorations });

// ---------- 图片粘贴 / 拖入（§B.5）：自动上传 → 在光标处插入 ![](path) ----------
function pasteDropUpload(opts) {
  const filesFrom = (dt) => {
    if (!dt) return [];
    let out = [...(dt.files || [])];
    if (!out.length && dt.items) {
      for (const i of dt.items) if (i.kind === 'file') { const f = i.getAsFile(); if (f) out.push(f); }
    }
    return out.filter((f) => /^image\//.test(f.type || ''));
  };
  const upload = async (view, files) => {
    let pos = view.state.selection.main.head;
    for (const f of files) {
      try {
        const p = await opts.uploadAsset(f);
        const text = `![](${p})`;
        view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
        pos += text.length;
      } catch (e) {
        window.__soliterraToast?.(String(e.message || e), 'error');
      }
    }
  };
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const files = filesFrom(event.clipboardData);
      if (files.length) {
        event.preventDefault();
        upload(view, files);
        return true;
      }
      // 粘贴净化（§B.4 + 第 93 轮）：【【X】】等 → [[X]]，并整套过符号规范化（全角→半角；「」保留）
      const text = event.clipboardData?.getData('text/plain') || '';
      if (/【【|〔〔|〖〖/.test(text)) {
        event.preventDefault();
        const clean = normalizeSymbols(text
          .replace(/【【(.+?)】】/g, '[[$1]]')
          .replace(/〔〔(.+?)〕〕/g, '[[$1]]')
          .replace(/〖〖(.+?)〗〗/g, '[[$1]]'));
        view.dispatch(view.state.replaceSelection(clean));
        return true;
      }
      return false;
    },
    drop: (event, view) => {
      const files = filesFrom(event.dataTransfer);
      if (!files.length) return false;
      event.preventDefault();
      const p = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (p != null) view.dispatch({ selection: { anchor: p } });
      upload(view, files);
      return true;
    },
  });
}

// ---------- 输入快捷格式（§B.4） ----------
// CM6 核心无 inputRules → 用 transactionFilter 改写「刚键入的字符」（只作用于 input.type，
// 不批量改写既有文档；每次转换 = 一个事务，⌘Z 整体可撤）。
function cjkBracketRules() {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.changes.empty) return tr;
    let ins = '', p0 = -1, count = 0, fromA = -1, toA = -1, selText = '';
    tr.changes.iterChanges((a, b, c, d, inserted) => {
      ins = String(inserted);                 // inserted 是 CM6 Text 对象，须 String()（=== 比较才成立）
      p0 = a; fromA = a; toA = b;
      selText = tr.startState.sliceDoc(a, b);   // 被替换的原选区文本
      count++;
    });
    if (p0 < 0 || !ins || count !== 1) return tr;             // 多光标输入不改写
    // 触发面：input.type = 真实键入/IME；input.paste = 粘贴；**无 input.* userEvent 的短插入**（IME
    // 一次上屏多字/程序化单点插入——长插入如 setValue 全文不受影响，仍不批量改写既有文档）。
    const ue = tr.annotations.some((a) => typeof a.value === 'string' && a.value.startsWith('input.'));
    if (!ue && ins.length > 4) return tr;
    const line = tr.startState.doc.lineAt(p0);
    const before = tr.startState.sliceDoc(line.from, p0);
    const full = before + ins;
    const after2 = tr.startState.sliceDoc(p0, p0 + 2);         // 原 doc 中光标后的两字（filter 坐标恒基于 startState）
    // ① 选中文字键入【 → [[选区]]（光标落 ]] 之前——spec「有选区 → [[选区]]」）
    if (ins === '【' && toA > fromA) {
      const text = selText;
      return { changes: [{ from: fromA, to: toA, insert: `[[${text}]]` }],
        selection: { anchor: fromA + 2 + text.length }, userEvent: 'input.type' };
    }
    // ② 【【 → [[|]]（光标居中）
    if (/【【$/.test(full)) {
      if (ins === '【【') {
        return { changes: [{ from: p0, insert: '[[]]' }],
          selection: { anchor: p0 + 2 }, userEvent: 'input.type' };
      }
      if (ins === '【' && before.endsWith('【')) {
        return { changes: [{ from: p0 - 1, to: p0, insert: '[[]]' }],
          selection: { anchor: p0 + 1 }, userEvent: 'input.type' };
      }
    }
    // ③ [[|]] 内再打【（已自动配对）→ 吞掉本次输入
    if (ins === '【' && after2 === ']]' && /\[\[[^\[\]]*$/.test(before)) {
      return { changes: [], selection: { anchor: p0 }, userEvent: 'input.type' };
    }
    // ④ 】】 → ]]（与未闭合 [[ 配对；已存在 ]] 时去重）
    if (/】】$/.test(full)) {
      if (after2 === ']]') return { changes: [], selection: { anchor: p0 }, userEvent: 'input.type' };
      if (ins === '】】') return { changes: [{ from: p0, insert: ']]' }], selection: { anchor: p0 + 2 }, userEvent: 'input.type' };
      if (ins === '】' && before.endsWith('】')) {
        return { changes: [{ from: p0 - 1, to: p0, insert: ']]' }], selection: { anchor: p0 + 1 }, userEvent: 'input.type' };
      }
    }
    return tr;
  });
}

// ---------- 符号自动转英文（第 93 轮 §B.4 扩展） ----------
// 与工具箱「符号规范化」同一张表（shared/symbols.js）：全角 ASCII 标点 / 弯引号 → 半角；
// 「」『』（）与中文句读**保留**。作用于「刚键入/粘贴的插入」（与 cjkBracketRules 同守卫：
// 程序化长插入如 setValue 不改写既有文档）；每次转换是一个事务，⌘Z 可撤。
function symbolRules() {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.changes.empty) return tr;
    let count = 0, hit = false, fromA = -1, toA = -1, ins = '';
    tr.changes.iterChanges((a, b, c, d, inserted) => {
      const s = String(inserted);
      fromA = a; toA = b; ins = s; count++;
      if (containsSymbol(s)) hit = true;
    });
    if (!hit || !ins || count !== 1) return tr;                    // 多光标/多段改动不改写
    const ue = tr.annotations.some((a) => typeof a.value === 'string' && a.value.startsWith('input.'));
    if (!ue && ins.length > 4) return tr;                          // 程序化长插入不改写；粘贴（input.paste）放行
    const clean = normalizeSymbols(ins);
    if (clean === ins) return tr;
    // 全表 1:1 字符映射 → 长度不变；光标落在转换后文本末尾（单光标惯例）
    return { changes: { from: fromA, to: toA, insert: clean },
      selection: { anchor: fromA + clean.length }, userEvent: 'input.type' };
  });
}

/** 键表（§B.2 解释文案；zh/en 按 opts.lang）——「词表是建议不是锁」（第 93 轮：删除示例列，只留解释）。 */
const META_DEFS = [
  ['s', '起始时间', '时间轴定位起点；* 模糊段，公元前加 -', 'Start time (timeline anchor; * fuzzy, - for BCE)'],
  ['e', '结束时间', '缺省 = 瞬时事件（轴上一个点）', 'End time; omit = instant event'],
  ['n', '标题', '不写则用文件名', 'Title; defaults to filename'],
  ['t', '标签', '空格分隔；书籍分类与图筛选', 'Tags (space separated)'],
  ['f', '事件分类', '时间轴旗标的分组维度', 'Flag group on the timeline'],
  ['a', '时代', '时间轴时代带：同代条目时间并集', 'Era band grouping'],
  ['p', '状态', '存储英文 token（UI 显示中文）', 'Status (stored as English token)'],
  ['v', '可见性', '读者视图分级（存中文值）', 'Visibility (reader-view gating)'],
  ['q', '可信度', '卡片徽章前置（存中文值）', 'Reliability badge'],
  ['m', '封面图', 'assets/ 相对路径', 'Cover image path'],
];
const CALLOUT_TYPES = [
  ['档案', '档案（平铺叙述，常规展示）', 'Archive (plain, always shown)'],
  ['作者', '作者（读者视图整体隐藏）', 'Author (hidden in reader view)'],
  ['剧透', '剧透（读者视图折叠）', 'Spoiler (folded in reader view)'],
  ['存疑', '存疑（虚线提示）', 'Doubt (dashed note)'],
];

/** 不在围栏代码块内（``` 奇数个在前 = 在块内）。 */
function inFence(doc, pos) {
  let n = 0;
  for (let i = 1; i < doc.lines; i++) {
    const l = doc.line(i);
    if (l.to > pos) break;
    if (/^\s*```/.test(l.text)) n++;
  }
  return n % 2 === 1;
}

/** `&` 行首键菜单：键名 + 中文名 + 一行解释 → 插 `&k ` 光标值位。 */
function metaMenu(source, lang) {
  return (context) => {
    const before = context.matchBefore(/&[a-z]{0,2}$/);
    if (!before || before.from !== context.state.doc.lineAt(context.pos).from) return null;
    if (inFence(context.state.doc, context.pos)) return null;
    const zh = lang !== 'en';
    return {
      from: before.from,
      options: META_DEFS.map(([k, nzh, dzh, den]) => ({
        label: `&${k} ${zh ? nzh : dzh.split(' (')[0]}`,
        detail: zh ? dzh : den,
        type: 'property',
        apply: (view, comp, f, t) => view.dispatch({
          changes: { from: f, to: t, insert: `&${k} ` },
          selection: { anchor: f + k.length + 2 },
        }),
      })),
      validFor: /^&[a-z]{0,2}$/,
    };
  };
}

/** 行首 `> ` → callout 类型选择 → 插 `> [!类型] `。 */
function calloutMenu(source, lang) {
  return (context) => {
    const before = context.matchBefore(/> $/);
    if (!before || before.from !== context.state.doc.lineAt(context.pos).from) return null;
    if (inFence(context.state.doc, context.pos)) return null;
    const zh = lang !== 'en';
    return {
      from: before.from,
      options: CALLOUT_TYPES.map(([name, dzh, den]) => ({
        label: `> [!${name}]`,
        detail: zh ? dzh : den,
        type: 'keyword',
        apply: (view, comp, f, t) => view.dispatch({
          changes: { from: f, to: t, insert: `> [!${name}] ` },
          selection: { anchor: f + `> [!${name}] `.length },
        }),
      })),
    };
  };
}

/** 行首 `/` 斜杠命令 → 插对应标记。 */
function slashMenu(context, lang) {
  if (!context.state.selection.main.empty) return null;        // 有选区不弹（/ 常规文本）
  const before = context.matchBefore(/\/[a-z]{0,8}$/);
  if (!before || before.from !== context.state.doc.lineAt(context.pos).from) return null;
  if (inFence(context.state.doc, context.pos)) return null;
  const zh = lang !== 'en';
  const cmds = [
    ['h1', '# ', 'H1', '一级标题'], ['h2', '## ', 'H2', '二级标题'], ['h3', '### ', 'H3', '三级标题'],
    ['b', '**', 'Bold', '粗体（包裹选区）'], ['i', '*', 'Italic', '斜体（包裹选区）'],
    ['code', '`', 'Code', '行内码'], ['quote', '> ', 'Quote', '引用'], ['list', '- ', 'List', '列表'],
    ['hr', '\n---\n', 'Divider', '分割线'], ['fence', '```event\n\n```', 'Fence', '围栏（event/rel/term/scene/passage）'],
    ['callout', '> ', 'Callout', 'callout（行首后弹类型）'], ['img', '![]()', 'Image', '图片（配合 ▣ 选择器）'],
  ];
  return {
    from: before.from,
    options: cmds.map(([id, ins, label, dzh]) => ({
      label: `/${id}`,
      detail: zh ? dzh : label,
      type: 'text',
      apply: (view, comp, f, t) => {
        view.dispatch({ changes: { from: f, to: t, insert: ins }, selection: { anchor: f + ins.length } });
        if (id === 'b' || id === 'i' || id === 'code') { /* 包裹标记：光标在标记间继续输入 */ }
        if (id === 'fence') view.dispatch({ selection: { anchor: f + 10 } });   // ```event\n 光标入块
        if (id === 'callout') startCompletion(view);
      },
    })),
  };
}

// ---------- 双链自动补全：输入 `[[` 触发条目下拉 ----------
function wikiCompletion(getEntries) {
  return (context) => {
    const before = context.matchBefore(/\[\[[^\]\n]*/);
    if (!before) return null;
    const word = before.text.slice(2);
    const entries = (getEntries && getEntries()) || [];
    const filtered = word
      ? entries.filter((e) => e.title.includes(word) || e.path.includes(word)).slice(0, 30)
      : entries.slice(0, 30);
    return {
      from: before.from + 2,
      options: filtered.map((e) => ({ label: e.title, detail: e.path, type: 'text' })),
      validFor: /^[^\]\n]*$/,
    };
  };
}

// ---------- 命令 ----------
function linePrefix(view, prefix) {
  const { state } = view;
  const changes = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from);
    const has = line.text.startsWith(prefix);
    changes.push({ from: line.from, to: line.from + (has ? prefix.length : 0), insert: has ? '' : prefix });
  }
  view.dispatch({ changes });
  view.focus();
}
function wrapSelection(view, before, after = before) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: [{ from: range.from, to: range.to, insert: before + text + after }],
      range: { anchor: range.from + before.length, head: range.from + before.length + text.length },
    };
  });
  view.dispatch(changes);
  view.focus();
}
function insertText(view, text) {
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

// ---------- 对外接口（window.SoliterraEditor） ----------
window.SoliterraEditor = {
  /**
   * @param container HTMLElement
   * @param opts { doc, onChange(text) }
   */
  create(container, opts = {}) {
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: opts.doc || '',
        extensions: [
          autocompletion({
            override: [
              wikiCompletion(opts.getEntries),
              metaMenu(null, opts.lang),                      // 行首 & → 键菜单（解释文案）
              calloutMenu(null, opts.lang),                   // 行首 > → callout 类型（工厂返回 source，勿再包一层）
              (ctx) => slashMenu(ctx, opts.lang),             // 行首 / → 斜杠命令
            ],
            icons: false, closeOnBlur: true,
          }),
          closeBrackets(),                                    // （）[] "" '' 自动配对、光标居中
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(highlight),
          decoPlugin(opts.resolveAsset),
          ...(opts.uploadAsset ? [pasteDropUpload(opts)] : []),
          cjkBracketRules(),                                  // 【【 → [[|]]、】】 → ]]
          symbolRules(),                                      // 第 93 轮：全角符号/弯引号 → 半角（「」保留）
          theme,
          keymap.of([
            { key: 'Mod-b', run: (v) => (wrapSelection(v, '**'), true) },
            { key: 'Mod-i', run: (v) => (wrapSelection(v, '*'), true) },
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    // 第 98 轮：点 & 元数据行不再弹编辑卡——CM6 默认光标落点即「直接编辑」（结构化入口在抽屉/阅读态）
    return {
      getValue: () => view.state.doc.toString(),
      setValue: (t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }),
      focus: () => view.focus(),
      requestMeasure: () => view.requestMeasure(),   // 分屏/容器宽度变化 → CM 重排（§B.3.4）
      h1: () => linePrefix(view, '# '),
      h2: () => linePrefix(view, '## '),
      h3: () => linePrefix(view, '### '),
      bold: () => wrapSelection(view, '**'),
      italic: () => wrapSelection(view, '*'),
      code: () => wrapSelection(view, '`'),
      quote: () => linePrefix(view, '> '),
      list: () => linePrefix(view, '- '),
      hr: () => insertText(view, '\n---\n'),
      wikilink: (name) => insertText(view, `[[${name}]]`),
      openWikiLink: () => {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: '[[' }, selection: { anchor: pos + 2 } });
        startCompletion(view);
        view.focus();
      },
      fence: (kind) => insertText(view, `\n\`\`\`${kind}\n\n\`\`\`\n`),
      meta: (key) => insertText(view, `\n&${key} `),
      /** 「＋ 添加元数据」：把 `&k ` 插到最后一个 & 行尾（无则文档头），光标落值位；单事务可 ⌘Z 撤。 */
      insertMetaLine: (key) => {
        const doc = view.state.doc;
        let last = null;
        for (let i = 1; i <= doc.lines; i++) { const l = doc.line(i); if (/^\s*&[a-z]/.test(l.text)) last = l; }
        const text = last ? ` &${key} ` : `&${key} \n`;
        const from = last ? last.to : 0;
        view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length } });
        view.focus();
      },
      image: (src, alt = '') => insertText(view, `![${alt}](${src})`),
      startCompletion: () => startCompletion(view),   // 手动触发补全（调试/快捷键可用）
      focusEnd: () => { view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); },
      destroy: () => view.destroy(),
    };
  },
};

// 供 esbuild 副作用引入
export {};
