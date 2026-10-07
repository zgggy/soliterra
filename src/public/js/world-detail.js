// Soliterra 世界/书籍详情面板（第 115 轮重设计：**统一可编辑表单**）
// 原则：编辑能力 ≥ 创建向导（简介/封面双入口/历法/时间线/标签/改名全部可改）；
// 两面板共用同一布局：左封面列（图 + 本机/assets 双入口 + 移除）→ 右表单列 → 底部 取消/保存。
// 保存：世界 POST worldinfo（&n 显示名/介绍首段/历法注释/时间线追加/封面设或移除——README 原子落盘）；
//      书籍 POST bookinfo（书名成对重命名/介绍/标签/封面——内容先写、改名最后）。
import { api, state, bindCoverFallbacks, t } from './app.js';
import { enc, esc, showToast, openPaperDialog2, openAssetPicker } from './ui.js';
import { hooks, refreshGitStatus, flattenTree } from './world-core.js';
import { refreshTree } from './world-tree.js';
import { readIntro } from '../../shared/intro.js';

/** 封面字段（两面板共用）：预览 + 双入口（本机系统对话框 / 项目内 assets）+ 移除——能力不小于创建向导。
 *  返回 { el, submit() }：submit 按操作态产出 cover 字段（undefined=不动 / 路径=设置 / ''=移除）。 */
function coverField(worldId, current) {
  const zh = state.lang === 'zh-CN';
  let op = { mode: current ? 'keep' : 'none', path: current || null, dataUrl: null };
  const wrap = document.createElement('div');
  wrap.className = 'cover-field';
  const paint = () => {
    const p = op.mode === 'local' ? op.dataUrl
      : (op.mode === 'assets' || op.mode === 'keep') && op.path ? `/w/${enc(worldId)}/${enc(op.path)}?t=${Date.now()}`
      : null;
    wrap.innerHTML = `
      <div class="detail-cover${p ? '' : ' is-empty'}">
        ${p ? `<img src="${p}" alt="">` : `<span class="detail-cover-glyph">${esc(current ? '🖼' : '＋')}</span><span class="detail-cover-hint eyebrow">${zh ? '未设置封面' : 'No cover'}</span>`}
      </div>
      <div class="cover-actions">
        <button class="button-ghost" type="button" data-a="local">${zh ? '从本机选择…' : 'From disk…'}</button>
        <button class="button-ghost" type="button" data-a="assets">${zh ? '从项目内选择…' : 'From assets…'}</button>
        ${current || op.mode !== 'none' ? `<button class="button-ghost" type="button" data-a="remove">${zh ? '移除' : 'Remove'}</button>` : ''}
      </div>`;
    wrap.querySelector('[data-a="local"]').addEventListener('click', async () => {
      try {
        const r = await api('/api/pick/file', { method: 'POST', body: {} });
        if (r.ok) { op = { mode: 'local', path: r.path, dataUrl: r.dataUrl || null }; paint(); }
      } catch (e) { showToast(String(e.message), 'error'); }
    });
    wrap.querySelector('[data-a="assets"]').addEventListener('click', async () => {
      try {
        const picked = await openAssetPicker({ worldId });
        if (picked) { op = { mode: 'assets', path: picked.path, dataUrl: null }; paint(); }
      } catch (e) { showToast(String(e.message), 'error'); }
    });
    wrap.querySelector('[data-a="remove"]')?.addEventListener('click', () => {
      op = { mode: 'remove', path: null, dataUrl: null }; paint();
    });
  };
  paint();
  return {
    el: wrap,
    submit: () => (op.mode === 'keep' ? undefined : op.mode === 'remove' ? '' : op.path || undefined),
  };
}

/** 统一表单字段行。fields: [{ key, label, value, control: 'input'|'textarea', rows?, placeholder?, hint? }] */
function fieldsHTML(fields) {
  return fields.map((f) => `
    <label class="field"><span class="eyebrow">${esc(f.label)}</span>
      ${f.control === 'textarea'
        ? `<textarea class="text-input" data-k="${esc(f.key)}" rows="${f.rows || 3}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>${esc(f.value || '')}</textarea>`
        : `<input class="text-input" data-k="${esc(f.key)}" value="${esc(f.value || '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>`}
      ${f.hint ? `<span class="field-note eyebrow">${esc(f.hint)}</span>` : ''}
    </label>`).join('');
}
const readonlyRow = (label, value) =>
  `<div class="set-row"><span class="eyebrow">${esc(label)}</span><span>${value}</span></div>`;

/** 打开详情面板（两面板共用骨架）。onDone = 保存成功后的外层刷新回调（首页卡片/树/面板）。 */
async function openDetail({ eyebrow, entry, fields, readonlyRows, coverInit, onSubmit, onDone }) {
  const { close, body } = openPaperDialog2(eyebrow);
  const cover = coverField(entry.worldId, coverInit);
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-cover-col" id="d-cover"></div>
      <div class="detail-info">
        <div class="detail-head"><span class="eyebrow">${esc(eyebrow)}</span></div>
        ${fieldsHTML(fields)}
        <div class="detail-readonly">${readonlyRows.join('')}</div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="button-ghost" data-x="cancel">${state.lang === 'zh-CN' ? '取消' : 'Cancel'}</button>
      <button class="button-primary" data-x="save">${state.lang === 'zh-CN' ? '保存修改' : 'Save changes'}</button>
    </div>
    <p class="modal-error" hidden></p>`;
  body.querySelector('#d-cover').appendChild(cover.el);
  bindCoverFallbacks(body);
  const err = body.querySelector('.modal-error');
  const saveBtn = body.querySelector('[data-x="save"]');
  body.querySelector('[data-x="cancel"]').addEventListener('click', close);
  const val = (k) => body.querySelector(`[data-k="${k}"]`)?.value ?? undefined;
  saveBtn.addEventListener('click', async () => {
    err.hidden = true;
    saveBtn.disabled = true;
    try {
      await onSubmit({ val, cover: cover.submit() });
      showToast(state.lang === 'zh-CN' ? '已保存' : 'Saved', 'success');
      onDone?.();
      close();
    } catch (e) {
      showToast(String(e.message), 'error');
      err.hidden = false;
      err.textContent = String(e.message);
      saveBtn.disabled = false;
    }
  });
}

/** 世界详情（首页卡片右键 / ⋯ 菜单「详情」）。 */
export async function openWorldDetail(w, onChanged) {
  const zh = state.lang === 'zh-CN';
  const rootRel = w.rootRel || 'README.md';
  let e;
  try { e = await api(`/api/w/${encodeURIComponent(w.id)}/entry?path=${encodeURIComponent(rootRel)}`); }
  catch (err) { showToast(String(err.message), 'error'); return; }
  const git = await api(`/api/w/${encodeURIComponent(w.id)}/git`).catch(() => ({ ok: false }));
  const calendar = (String(e.body || '').match(/<!--\s*calendar:\s*(.*?)\s*-->/) || [])[1] || '';
  const gitRow = git.ok
    ? readonlyRow('git', `${esc(git.branch)} · ${esc(git.hash)} · ${esc(git.when)}`)
    : readonlyRow('git', zh ? '非 git 仓库' : 'not a repo');
  await openDetail({
    eyebrow: zh ? `世界详情 · ${w.name}` : `World · ${w.name}`,
    entry: { worldId: w.id },
    fields: [
      { key: 'name', label: zh ? '显示名（不动文件夹）' : 'Display name (folder unchanged)', control: 'input', value: e.meta?.n?.[0] || w.name, hint: zh ? '首页卡片与根条目标题；文件夹/世界 id 不变' : 'Card & root title; folder/id unchanged' },
      { key: 'intro', label: zh ? '一句介绍（README 正文首段）' : 'Intro (README first block)', control: 'textarea', rows: 3, value: readIntro(e.body), placeholder: zh ? '留空 = 删除介绍段' : 'Empty = remove intro block' },
      { key: 'calendar', label: zh ? '历法与纪元锚点（README 注释）' : 'Calendar (README comment)', control: 'input', value: calendar, placeholder: 'CE 元年=0705', hint: zh ? '留空 = 删除历法注释' : 'Empty = remove comment' },
      { key: 'timeline', label: zh ? '追加时间线事件' : 'Append timeline events', control: 'textarea', rows: 4, value: '', placeholder: zh ? '每行一个事件（须含 &s …）——保存时追加为新文件，同名跳过' : 'One event per line (&s …); appended, duplicates skipped' },
    ],
    readonlyRows: [
      readonlyRow(zh ? '条目' : 'Entries', `<b>${w.stats.entries}</b>`),
      readonlyRow(zh ? '位置' : 'Location', `<span class="wz-path" title="${esc(w.dir || '')}">${esc(w.dir || '')}</span>`),
      gitRow,
    ],
    coverInit: e.meta?.m?.[0] || null,
    onSubmit: async ({ val, cover }) => {
      const body = {};
      const name = val('name')?.trim();
      if (name) body.name = name;
      body.intro = val('intro') ?? '';            // 空 = 删介绍段
      body.calendar = val('calendar') ?? '';      // 空 = 删历法注释
      const tl = val('timeline')?.trim();
      if (tl) body.timeline = tl;                 // 仅非空时追加（空 = 不动已有事件）
      if (cover !== undefined) body.cover = cover;
      const r = await api(`/api/w/${encodeURIComponent(w.id)}/worldinfo`, { method: 'POST', body });
      if (r.events) showToast(zh ? `已追加 ${r.events} 个时间线事件` : `Added ${r.events} timeline events`, 'success');
    },
    onDone: () => onChanged?.(),
  });
}

/** 书籍详情（世界内树行/书卡右键「书籍详情」）。 */
export async function openBookDetail(ctx, node) {
  const zh = state.lang === 'zh-CN';
  if (!node?.md) { showToast(zh ? '纯目录节点先「补建同名条目」才有元数据位' : 'Create the paired entry first', 'warning'); return; }
  let e;
  try { e = await api(`/api/w/${encodeURIComponent(ctx.worldId)}/entry?path=${encodeURIComponent(node.md)}`); }
  catch (err) { showToast(String(err.message), 'error'); return; }
  const entries = flattenTree(node).length - (node.md ? 1 : 0);
  const timed = ctx.timeline.filter((r) => r.path === node.md || r.path.startsWith(node.dir + '/')).length;
  const origName = node.title || node.name;
  await openDetail({
    eyebrow: zh ? `书籍详情 · ${origName}` : `Book · ${origName}`,
    entry: { worldId: ctx.worldId },
    fields: [
      { key: 'name', label: zh ? '书名（保存时成对重命名 md+目录）' : 'Book name (renames md+folder)', control: 'input', value: origName, hint: zh ? '留空 = 不改名；重名冲突会保存失败' : 'Empty = keep; conflicts fail the save' },
      { key: 'intro', label: zh ? '简介（正文首段）' : 'Intro (first block)', control: 'textarea', rows: 3, value: readIntro(e.body), placeholder: zh ? '留空 = 删除介绍段' : 'Empty = remove intro block' },
      { key: 'tags', label: zh ? '标签（空格分隔 · 书籍面板分类用）' : 'Tags (space separated · panel filters)', control: 'input', value: (e.meta?.t || []).join(' '), placeholder: zh ? '留空 = 移除全部标签' : 'Empty = remove tags' },
    ],
    readonlyRows: [
      readonlyRow(zh ? '路径' : 'Path', `<span class="wz-path">${esc(node.md)}</span>`),
      readonlyRow(zh ? '子条目' : 'Entries', `<b>${entries}</b>`),
      readonlyRow(zh ? '上轴条目' : 'Timed', `<b>${timed}</b>`),
    ],
    coverInit: e.meta?.m?.[0] || null,
    onSubmit: async ({ val, cover }) => {
      const body = { path: node.md };
      const name = val('name')?.trim();
      if (name) body.name = name;
      body.intro = val('intro') ?? '';
      body.tags = val('tags')?.trim() ?? '';
      if (cover !== undefined) body.cover = cover;
      await api(`/api/w/${encodeURIComponent(ctx.worldId)}/bookinfo`, { method: 'POST', body });
    },
    onDone: () => { refreshTree(ctx).then(() => refreshGitStatus(ctx)); },
  });
}

// 注册进 hooks（首页与树菜单经此调用）
hooks.openWorldDetail = openWorldDetail;
hooks.openBookDetail = openBookDetail;
