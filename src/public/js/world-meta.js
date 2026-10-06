// Soliterra 元数据结构化编辑（§5.3 / §B.2 抽屉；第 92 轮拆分出独立模块）。
import { api, state } from './app.js';
import { enc, esc, showToast, openPaperDialog2 } from './ui.js';
import { refreshGitStatus, refreshTimeline, topBookNodes, hooks } from './world-core.js';
import { normalizeDateValue } from '../../shared/date.js';   // 第 95 轮：日期宽松输入 + 确认时规范化（补零）

// ============ §5.3 元数据结构化编辑（按键类型弹控件；返回最终值或 null） ============
const META_ENUM = {
  p: [['canon', '正典'], ['draft', '草稿'], ['disputed', '存疑'], ['deprecated', '废弃']],
  v: [['公众', '公众'], ['秘传', '秘传'], ['作者', '作者']],
  q: [['可靠', '可靠'], ['存疑', '存疑'], ['已证伪', '已证伪'], ['立场鲜明', '立场鲜明']],
};
const META_LABEL = { s: '起始时间', e: '结束时间', t: '标签', f: '事件分类', n: '标题', a: '时代', p: '状态', v: '可见性', q: '可信度', m: '封面图', r: '顺序' };
// §B.2 元数据抽屉键表（与《全景时间轴与编辑器增强设计.md》§B.2 一致：名 / 解释 / 示例）
const META_KEY_DOC = {
  s: { zh: '时间轴定位起点；`*` 为模糊段，公元前加 `-`', en: 'Timeline start; * fuzzy, - for BCE' },
  e: { zh: '结束时间；缺省 = 瞬时事件（轴上一个点）', en: 'End; omit = instant event' },
  n: { zh: '标题；不写则用文件名', en: 'Title; defaults to filename' },
  t: { zh: '标签（空格分隔）；书籍分类与图筛选', en: 'Tags (space separated)' },
  f: { zh: '事件分类——时间轴旗标的分组维度', en: 'Flag group on the timeline' },
  a: { zh: '时代——时间轴时代带，同代条目时间并集', en: 'Era band grouping' },
  p: { zh: '状态（存英文 token）：canon / draft / disputed / deprecated', en: 'Status token: canon/draft/disputed/deprecated' },
  v: { zh: '可见性——读者视图分级（存中文值）', en: 'Visibility (reader-view gating)' },
  q: { zh: '可信度——卡片徽章前置（存中文值）', en: 'Reliability badge' },
  m: { zh: '封面图——assets/ 相对路径', en: 'Cover image path' },
  r: { zh: '同层目录顺序（1 起）——目录里拖动即自动整层重写', en: 'Sibling order (1+) — rewritten by TOC drag' },
};
const META_ORDER = ['s', 'e', 'n', 't', 'f', 'a', 'p', 'v', 'q', 'm', 'r'];

/** 从文档文本解析 & 元数据（单行值断于下个键或行尾）→ Map<key, {value}>。 */
export function parseMetaFromDoc(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!/^\s*&[a-z]/.test(line)) continue;
    const re = /&([a-z])(?:\s+([^&]*))?/g;
    let m;
    while ((m = re.exec(line))) map.set(m[1], { value: (m[2] || '').trim() });
  }
  return map;
}

/** 文本级改写单个元数据键（value 为空 = 删键；整行无键则删行）。编辑态与保存管线共用。 */
function applyMetaToText(text, key, value) {
  if (value === '' || value == null) {
    const re = new RegExp(`(^|\\s)&${key}(?=\\s|$)`);
    const out = [];
    for (const line of text.split('\n')) {
      if (!re.test(line)) { out.push(line); continue; }
      const nl = line
        .replace(new RegExp(`(^|\\s)&${key}\\s*[^&]*`), '$1')
        .replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
      if (nl.trim() === '' || nl.trim() === '&') continue;      // 行里没别的键了 → 删行
      out.push(nl);
    }
    return out.join('\n');
  }
  const kv = new RegExp(`&${key}\\s+[^&\\n]*`);
  if (kv.test(text)) return text.replace(kv, `&${key} ${value} `);
  return `&${key} ${value}\n` + text;                           // 键不存在 → 插入文档头
}

/** 在文档的 & 行区插入空键 `&k `（追加到最后一个 & 行尾；无 & 行则插入文档头）；返回新文本。 */
export function insertMetaIntoText(text, key) {
  const lines = text.split('\n');
  let lastMetaIdx = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*&[a-z]/.test(lines[i])) lastMetaIdx = i;
  if (lastMetaIdx >= 0) {
    lines[lastMetaIdx] = `${lines[lastMetaIdx].replace(/\s+$/, '')} &${key} `;
    return lines.join('\n');
  }
  return `&${key} \n${text}`;
}

/** 保存元数据：编辑态写回 CM6 编辑器（不重渲染，防抖自动保存）；阅读态走服务端 + 原地重载。 */
export async function saveMetaFromEditor(ctx, key, value) {
  if (ctx.editing && ctx.editor) {
    const cur = ctx.editor.getValue();
    const next = applyMetaToText(cur, key, value);
    if (next !== cur) ctx.editor.setValue(next);                // CM6 内一个事务（⌘Z 可撤）→ onChange 触发保存与抽屉重扫
    return;
  }
  await editMetaValue(ctx, key, value);
}

/** 元数据抽屉（§B.2 编辑态顶条）：chips 即点即改 + 末尾「＋」添加。文档改动后防抖重扫。 */
export function renderMetaDrawer(ctx) {
  const host = document.getElementById('meta-drawer');
  if (!host || !ctx.editing || !ctx.editor) return;
  let meta;
  try { meta = parseMetaFromDoc(ctx.editor.getValue()); } catch { return; }
  const keys = [...META_ORDER.filter((k) => meta.has(k)), ...[...meta.keys()].filter((k) => !META_ORDER.includes(k))];
  host.innerHTML = keys.map((k) => {
    const v = meta.get(k)?.value || '';
    const known = META_ORDER.includes(k);
    return `<button class="md-chip${v ? '' : ' empty'}${known ? '' : ' custom'}" data-k="${esc(k)}" title="${esc(META_LABEL[k] || '自定义键')}">
      <span class="k">&${esc(k)}</span><span class="v">${v ? esc(v) : '—'}</span></button>`;
  }).join('') + `<button class="md-add" id="md-add" title="${state.lang === 'zh-CN' ? '添加元数据' : 'Add metadata'}">＋</button>`;
  host.querySelectorAll('.md-chip').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.k;
    const val = await openMetaEditor(ctx, k, meta.get(k)?.value || '');
    if (val === null) return;
    await saveMetaFromEditor(ctx, k, val.trim());
  }));
  host.querySelector('#md-add')?.addEventListener('click', () => openAddMeta(ctx));
}

/** 「＋ 添加元数据」菜单：键表（名+解释+示例）；已存在 → 开其编辑卡，否则插入 `&k ` 光标值位。 */function openAddMeta(ctx) {
  const { close, body } = openPaperDialog2('＋ ' + (state.lang === 'zh-CN' ? '添加元数据' : 'Add metadata'));
  const zh = state.lang !== 'en';
  let meta = new Map();
  try { meta = parseMetaFromDoc(ctx.editor?.getValue() || ''); } catch {}
  const rowHTML = (k, name, doc2) => `<button class="am-row" data-k="${esc(k)}" ${meta.has(k) ? 'data-exists="1"' : ''}>
      <span class="am-key">&${esc(k)}</span><span class="am-name">${esc(name)}</span>
      <span class="am-desc">${esc(doc2)}</span></button>`;
  body.innerHTML = `
    <div class="am-list">
      ${META_ORDER.map((k) => rowHTML(k, META_LABEL[k], META_KEY_DOC[k] ? META_KEY_DOC[k][zh ? 'zh' : 'en'] : '')).join('')}
    </div>
    <div class="am-custom">
      <input class="text-input" id="am-key" maxlength="1" placeholder="${state.lang === 'zh-CN' ? '自定义键（单个小写字母）' : 'Custom key (one lowercase letter)'}">
      <button class="button-ghost" id="am-ok">${state.lang === 'zh-CN' ? '插入' : 'Insert'}</button>
    </div>`;
  const addKey = async (k) => {
    if (!/^[a-z]$/.test(k)) { showToast(state.lang === 'zh-CN' ? '键须为单个小写字母' : 'Single lowercase letter', 'warning'); return; }
    close();
    if (meta.has(k)) {                                      // 已存在 → 开编辑卡
      const val = await openMetaEditor(ctx, k, meta.get(k).value || '');
      if (val !== null) await saveMetaFromEditor(ctx, k, val.trim());
      return;
    }
    if (!ctx.editor?.insertMetaLine) { showToast(state.lang === 'zh-CN' ? '请在编辑态使用' : 'Editor only', 'warning'); return; }
    ctx.editor.insertMetaLine(k);                           // 插 `&k ` 到 & 行区并聚焦值位（一个事务可撤）
    renderMetaDrawer(ctx);
  };
  body.querySelectorAll('.am-row').forEach((b) => b.addEventListener('click', () => addKey(b.dataset.k)));
  body.querySelector('#am-ok').addEventListener('click', () => addKey(body.querySelector('#am-key').value.trim().toLowerCase()));
  body.querySelector('#am-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKey(body.querySelector('#am-key').value.trim().toLowerCase()); });
}

export function openMetaEditor(ctx, key, current) {
  return new Promise((resolve) => {
    const isDate = key === 's' || key === 'e';
    const isTags = key === 't';
    const seg = META_ENUM[key];
    const flagCats = [...new Set(ctx.timeline.map((r) => r.flag).filter(Boolean))];
    const bookTags = [...new Set(topBookNodes(ctx).flatMap((b) => b.tags || []))];
    let tags = isTags ? String(current || '').split(/\s+/).filter(Boolean) : [];
    const kdoc = META_KEY_DOC[key];
    const explain = kdoc ? (state.lang === 'en' ? kdoc.en : kdoc.zh) : '';
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog ask-dialog">
        <div class="modal-header"><span class="eyebrow">&amp;${esc(key)} · ${esc(META_LABEL[key] || (state.lang === 'en' ? 'Custom key' : '自定义键'))}</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-scroll">
          ${explain ? `<p class="meta-explain">${esc(explain)}</p>` : ''}
          ${isDate ? `
            <input class="text-input meta-date" value="${esc(current)}" placeholder="yyyy.mm.dd（* 为模糊段；705.9.10 / 705/9/10 / 705年9月10日 / 前300 等确认时自动规范）">
            <div class="meta-hint" hidden></div>
            <div class="meta-quick">
              <button class="button-ghost" type="button" data-fuzzy-year>日段模糊</button>
              <button class="button-ghost" type="button" data-fuzzy-all>年月日全模糊</button>
            </div>` : ''}
          ${seg ? `
            <div class="seg meta-seg">${seg.map(([v2, label]) => `<button type="button" data-val="${esc(v2)}" class="${current === v2 ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>
            <input class="text-input meta-text" value="${esc(current)}" placeholder="或输入自定义值">` : ''}
          ${isTags ? `
            <div class="meta-chips">${tags.map((t2) => `<span class="meta-chip">${esc(t2)}<button type="button" data-del="${esc(t2)}">×</button></span>`).join('') || '<span class="meta-chip empty">—</span>'}</div>
            <input class="text-input meta-text" list="meta-tag-list" placeholder="输入标签后回车（可多选）">
            <datalist id="meta-tag-list">${bookTags.map((t2) => `<option value="${esc(t2)}">`).join('')}</datalist>` : ''}
          ${!isDate && !seg && !isTags ? `
            <input class="text-input meta-text" value="${esc(current)}" ${key === 'f' ? 'list="meta-flag-list"' : ''} placeholder="${key === 'm' ? 'assets/… 图片路径' : ''}">
            ${key === 'm' ? `<button class="button-ghost" type="button" data-pick-cover>${state.lang === 'zh-CN' ? '从本机选图…' : 'Pick image…'}</button>` : ''}
            ${key === 'f' ? `<datalist id="meta-flag-list">${flagCats.map((f2) => `<option value="${esc(f2)}">`).join('')}</datalist>` : ''}` : ''}
          <div class="modal-actions">
            <button class="button-ghost meta-del" data-del-key>${state.lang === 'en' ? 'Delete key' : '删除该键'}</button>
            <button class="button-ghost" data-close>取消</button>
            <button class="button-primary" data-ok>确定</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const dateInput = modal.querySelector('.meta-date');
    const hint = modal.querySelector('.meta-hint');
    const okBtn = modal.querySelector('[data-ok]');
    const done = (v) => { modal.remove(); resolve(v); };

    // 第 95 轮：各种日期写法都不阻碍确认（705.9.10 / 705/9/10 / 705年9月10日 / 0705.9 / 前300 …）——
    // 只有识别不了的值才阻止；确认时 collect() 归一为 yyyy.mm.dd（月/日补足两位、年补足四位，* 段保留）。
    const validateDate = () => {
      if (!dateInput) return true;
      const v = dateInput.value.trim();
      const ok = v === '' || normalizeDateValue(v) !== null;
      dateInput.classList.toggle('invalid', !ok);
      okBtn.disabled = !ok;
      if (hint) {
        hint.hidden = ok || v === '';
        hint.textContent = ok ? '' : (state.lang === 'zh-CN'
          ? '无法识别为日期——支持 705.9.10、705/9/10、705年9月10日、0705.9、前300 等写法，确认时自动规范为 yyyy.mm.dd'
          : 'Not a date — accepts 705.9.10, 705/9/10, 705y9m10d, 0705.9, 300 BCE…; normalized to yyyy.mm.dd on confirm');
      }
      return ok;
    };
    if (dateInput) {
      dateInput.addEventListener('input', validateDate);
      validateDate();
      // 模糊按钮：先规范化（宽松输入也能截），再截段（第 95 轮）
      modal.querySelector('[data-fuzzy-year]')?.addEventListener('click', () => {
        const norm = normalizeDateValue(dateInput.value.trim());
        const m2 = norm && norm.match(/^(-?\d{1,4})\.(\d{2}|\*)\.(\d{2}|\*)$/);
        if (m2) dateInput.value = `${m2[1]}.${m2[2]}.*`;
        validateDate();
      });
      modal.querySelector('[data-fuzzy-all]')?.addEventListener('click', () => {
        const norm = normalizeDateValue(dateInput.value.trim());
        const m2 = norm && norm.match(/^(-?\d{1,4})/);
        if (m2) dateInput.value = `${m2[1]}.*.*`;
        validateDate();
      });
    }
    // 枚举下拉 + 自定义
    const segBtns = [...modal.querySelectorAll('.meta-seg button')];
    segBtns.forEach((b) => b.addEventListener('click', () => {
      const on = b.classList.contains('on');
      segBtns.forEach((x) => x.classList.remove('on'));
      if (!on) b.classList.add('on');
      const custom = modal.querySelector('.meta-text');
      if (custom) custom.value = on ? '' : b.dataset.val;
    }));
    const custom = modal.querySelector('.meta-text');
    if (custom && segBtns.length) custom.addEventListener('input', () => segBtns.forEach((x) => x.classList.remove('on')));
    // &m 封面：选图 → 复制进 assets/covers/（不写 &m——由确定按钮的文本路径统一写，防编辑态 mtime 互踩）
    modal.querySelector('[data-pick-cover]')?.addEventListener('click', async (e2) => {
      const btn = e2.currentTarget;
      btn.disabled = true;
      try {
        const pick = await api('/api/pick/file', { method: 'POST', body: {} });
        if (pick.ok) {
          const r = await api(`/api/w/${enc(ctx.worldId)}/cover`, { method: 'POST', body: { path: ctx.currentPath, image: pick.path, writeMeta: false } });
          if (custom) custom.value = r.cover;
        }
      } catch (err) { showToast(String(err.message), 'error'); }
      btn.disabled = false;
    });
    // 标签 chips
    if (isTags) {
      const rerender = () => {
        modal.querySelector('.meta-chips').innerHTML = tags.map((t2) => `<span class="meta-chip">${esc(t2)}<button type="button" data-del="${esc(t2)}">×</button></span>`).join('') || '<span class="meta-chip empty">—</span>';
        modal.querySelectorAll('[data-del]').forEach((b2) => b2.addEventListener('click', () => { tags = tags.filter((x) => x !== b2.dataset.del); rerender(); }));
      };
      custom?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = custom.value.trim();
        if (v && !tags.includes(v)) { tags.push(v); rerender(); }
        custom.value = '';
      });
      rerender();
    }
    const collect = () => {
      if (isDate) {
        const v = dateInput.value.trim();
        if (!v) return '';
        const norm = normalizeDateValue(v);   // 第 95 轮：确认即规范化（validateDate 已保证可识别）
        return norm !== null ? norm : v;
      }
      if (isTags) {
        const pending = custom?.value.trim();
        const all = pending && !tags.includes(pending) ? [...tags, pending] : tags;
        return all.join(' ');
      }
      if (segBtns.some((b) => b.classList.contains('on'))) return segBtns.find((b) => b.classList.contains('on')).dataset.val;
      return custom ? custom.value.trim() : '';
    };
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => done(null)));
    modal.querySelector('[data-del-key]')?.addEventListener('click', () => done(''));   // 空串 = 删键（§5.3）
    okBtn.addEventListener('click', () => { if (!validateDate()) return; done(collect()); });
    const inp = modal.querySelector('.text-input');
    inp?.focus(); inp?.select?.();
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && !isTags) { if (!validateDate()) return; done(collect()); }
    });
  });
}

/** 编辑单个元数据键：更新其 & 行中的值并保存（同行其他键保留）。 */
export async function editMetaValue(ctx, key, value) {
  let raw = ctx.currentRaw || '';
  raw = applyMetaToText(raw, key, value);   // value 空 = 删键（整行无键则删行）；否则同行改值/头部插入
  try {
    const r = await api(`/api/w/${enc(ctx.worldId)}/save`, { method: 'POST', body: { path: ctx.currentPath, text: raw, baseMtime: ctx.currentMtime ?? null } });
    ctx.currentMtime = r.mtime ?? ctx.currentMtime;   // 第 92 轮：乐观锁基准前移
    refreshGitStatus(ctx);
    await refreshTimeline(ctx);   // 元数据改完即刻上轴（含范围重算）
    await hooks.openEntry?.(ctx, ctx.currentPath, ctx.chrono);   // 原地重载正文（不重建面板；打开本就不取景）
  } catch (err) { showToast(String(err.message), 'error'); }
}

