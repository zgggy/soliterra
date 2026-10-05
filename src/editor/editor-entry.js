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
import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

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

  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const text = line.text;

    // & 元数据行（行首 &）——整行样式化
    if (/^\s*&[a-z]/.test(text)) {
      items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-meta-line' }) });
      continue;
    }
    // 围栏头 ```type
    if (/^```\w+/.test(text)) {
      items.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-fence-head' }) });
    }
    const rawLine = ln === curLine;       // 光标行显原文（图片不折叠）
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
      if (!files.length) return false;
      event.preventDefault();
      upload(view, files);
      return true;
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
          autocompletion({ override: [wikiCompletion(opts.getEntries)], icons: false, closeOnBlur: true }),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(highlight),
          decoPlugin(opts.resolveAsset),
          ...(opts.uploadAsset ? [pasteDropUpload(opts)] : []),
          theme,
          keymap.of([
            { key: 'Mod-b', run: (v) => (wrapSelection(v, '**'), true) },
            { key: 'Mod-i', run: (v) => (wrapSelection(v, '*'), true) },
            ...defaultKeymap, ...historyKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    return {
      getValue: () => view.state.doc.toString(),
      setValue: (t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }),
      focus: () => view.focus(),
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
      image: (src, alt = '') => insertText(view, `![${alt}](${src})`),
      startCompletion: () => startCompletion(view),   // 手动触发补全（调试/快捷键可用）
      focusEnd: () => { view.dispatch({ selection: { anchor: view.state.doc.length } }); view.focus(); },
      destroy: () => view.destroy(),
    };
  },
};

// 供 esbuild 副作用引入
export {};
