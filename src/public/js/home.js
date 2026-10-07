// 首页 · 世界列表（功能设计 §1）
// 横排竖卡 + hover 倾斜 + 滚轮左右滚动 + 「+」新建卡 + 新建向导。

import { api, t, state, bindCoverFallbacks, abbrevPath, copyText } from './app.js';
import { esc as escapeHtml, showToast, askText } from './ui.js';
import { hooks } from './world-core.js';

// 平台元信息（世界库根 + 家目录）：卡片「位置」行与新建向导目标预览共用（renderHome 时拉取）
let homeMeta = { worldsDir: '', home: '' };

export async function renderHome(root) {
  root.innerHTML = `
    <header class="home-masthead">
      <div class="masthead-inner">
        <span class="brandmark">
          <span class="brandmark-main">${t('app.name')}</span>
          <span class="brandmark-sub">WORLD ARCHIVE</span>
        </span>
        <span class="masthead-actions">
          <button class="icon-button" id="import-obsidian" title="${t('imp.title')}">${t('imp.short')}</button>
          <button class="icon-button" data-lang-switch title="Language">${t('lang.switch')}</button>
        </span>
      </div>
    </header>
    <main class="home-shell">
      <div class="world-row" id="world-row"></div>
      <p class="home-tagline">${t('app.tagline')}</p>
    </main>`;

  const row = root.querySelector('#world-row');
  let worlds = [];
  try { worlds = await api('/api/worlds'); } catch (e) { console.error(e); }
  try { homeMeta = await api('/api/meta'); } catch { /* 老服务无此端点：位置显示降级隐藏 */ }

  if (worlds.length === 0) {
    row.innerHTML = `<div class="empty-state">${t('home.empty')}</div>`;
  }
  const refresh = () => renderHome(root);   // 详情面板改封面后刷新卡片
  for (const w of worlds) {
    const card = document.createElement('a');
    card.className = 'world-card';
    card.href = `#/w/${encodeURIComponent(w.id)}`;
    const dirFull = w.dir || '';
    const dirShow = dirFull ? abbrevPath(dirFull, homeMeta.home) + '/' : '';
    card.innerHTML = `
      <div class="world-card-cover">${w.cover
        ? `<img src="/w/${encodeURIComponent(w.id)}/${encodeURIComponent(w.cover)}" alt="" data-glyph="${escapeHtml(w.name.slice(0, 1))}" data-glyph-class="world-card-glyph">`
        : `<span class="world-card-glyph">${escapeHtml(w.name.slice(0, 1))}</span>`}</div>
      <button class="world-card-menu" title="${t('home.worldActions')}">⋯</button>
      <div class="world-card-body">
        <h3 class="world-card-title">${escapeHtml(w.name)}</h3>
        <p class="world-card-sub">${escapeHtml(w.subtitle || '')}</p>
        ${dirShow ? `<div class="world-card-path" title="${escapeHtml(dirFull)}">${escapeHtml(dirShow)}</div>` : ''}
        <div class="world-card-meta">${w.stats.entries} ${t('world.entries')} · ${w.stats.events} ${t('world.events')}</div>
      </div>`;
    row.appendChild(card);
    attachTilt(card);
    bindCoverFallbacks(card);
    card.querySelector('.world-card-menu')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWorldMenu(e, w, refresh);
    });
    // 右键 = 世界详情面板（第 92 轮：封面/统计/git 图形化管理）
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); hooks.openWorldDetail?.(w, refresh); });
  }

  const plus = document.createElement('button');
  plus.className = 'world-card world-card-new';
  plus.innerHTML = `<span class="plus-glyph">+</span><span class="eyebrow">${t('home.new')}</span>`;
  plus.addEventListener('click', () => openNewWorld(root));
  row.appendChild(plus);
  attachTilt(plus);

  // 滚轮 → 横向滚动
  const shell = root.querySelector('.home-shell');
  shell.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    }
  }, { passive: false });


  // Obsidian 导入（§15.6）：输入库绝对路径 + 世界名 → 复制为新世界
  root.querySelector('#import-obsidian')?.addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog settings-dialog">
        <div class="modal-header">
          <span class="eyebrow">${t('imp.title')}</span>
          <button class="modal-close" data-close>×</button>
        </div>
        <div class="modal-scroll">
          <label class="field"><span class="eyebrow">${t('imp.path')}</span>
            <input class="text-input" name="src" placeholder="/Users/me/Documents/MyVault" autofocus></label>
          <label class="field"><span class="eyebrow">${t('home.new.name')}</span>
            <input class="text-input" name="name"></label>
          <div class="field-note eyebrow" style="color:var(--text-muted)">${t('imp.note')}</div>
          <div class="modal-actions">
            <button class="button-ghost" data-close>${t('ui.cancel')}</button>
            <button class="button-primary" data-import>${t('imp.do')}</button>
          </div>
          <p class="modal-error" hidden></p>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-import]').addEventListener('click', async () => {
      const src = modal.querySelector('[name=src]').value.trim();
      const name = modal.querySelector('[name=name]').value.trim();
      if (!src || !name) return;
      try {
        const r = await api('/api/worlds/import', { method: 'POST', body: { path: src, name } });
        close();
        location.hash = `#/w/${encodeURIComponent(name)}`;
      } catch (e) {
        const err = modal.querySelector('.modal-error');
        err.hidden = false; err.textContent = e.message;
      }
    });
  });
}

// 卡片 hover 倾斜（hover-tilt 原语：perspective 1200 / ±6deg / 200ms）
export function attachTilt(card) {
  card.addEventListener('mousemove', (e) => {
    const r = card.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = (e.clientY - r.top) / r.height - 0.5;
    card.style.transform = `rotateX(${(-dy * 12).toFixed(2)}deg) rotateY(${(dx * 12).toFixed(2)}deg)`;
  });
  card.addEventListener('mouseleave', () => { card.style.transform = ''; });
}

// 世界操作菜单（§1.1：位置（完整路径）· 在 Finder 中显示 · 复制完整路径 · 重命名 / 复制 / 删除——删除须输入世界名确认）
async function showWorldMenu(e, w, refresh) {
  document.querySelectorAll('.tree-menu').forEach((m) => m.remove());
  const zh = state.lang === 'zh-CN';
  const dirFull = w.dir || '';
  const dirShow = dirFull ? abbrevPath(dirFull, homeMeta.home) + '/' : '';
  const menu = document.createElement('div');
  menu.className = 'tree-menu';
  menu.innerHTML = `
    <button class="tree-menu-item" data-k="detail">${t('home.menuDetail')}</button>
    ${dirShow ? `<div class="tree-menu-note" title="${escapeHtml(dirFull)}">${escapeHtml(dirShow)}</div>
    <button class="tree-menu-item" data-k="reveal">${t('detail.reveal')}</button>
    <button class="tree-menu-item" data-k="copy">${t('home.menuCopy')}</button>
    <div class="tree-menu-sep"></div>` : ''}
    <button class="tree-menu-item" data-k="rename">${w.linked ? t('home.menuRenameLinked') : t('home.menuRename')}</button>
    <button class="tree-menu-item" data-k="dup">${t('home.menuDup')}</button>
    <button class="tree-menu-item" data-k="unmanage">${t('home.menuUnmanage')}</button>`;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
  const off = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', off); } };
  document.addEventListener('pointerdown', off);
  menu.addEventListener('click', async (ev) => {
    const k = ev.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    menu.remove();
    try {
      if (k === 'detail') { hooks.openWorldDetail?.(w, refresh); return; }
      if (k === 'reveal') {
        await api('/api/worlds/reveal', { method: 'POST', body: { id: w.id } });
      } else if (k === 'copy') {
        const ok = await copyText(dirFull);
        showToast(ok ? t('home.pathCopied') : t('home.copyFailed'));
      } else if (k === 'rename') {
        const nn = await askText(t('home.new.name'), w.name);
        if (!nn || !nn.trim() || nn.trim() === w.name) return;
        await api('/api/worlds/rename', { method: 'POST', body: { id: w.id, newName: nn.trim() } });
        location.reload();
      } else if (k === 'dup') {
        const nn = await askText(t('home.copyName'), `${w.name} ${t('home.copySuffix')}`);
        if (!nn || !nn.trim()) return;
        await api('/api/worlds/duplicate', { method: 'POST', body: { id: w.id, newName: nn.trim() } });
        location.reload();
      } else if (k === 'unmanage') {
        // 第 90 轮：世界卡不删除本地文件——仅把文件夹移出平台管理列表（可再次「新建世界」选中恢复）
        const conf = await askText(zh
          ? `取消管理「${w.name}」？输入世界名完全一致以确认（本地文件夹原样保留，可随时重新选择该文件夹恢复管理）`
          : `Stop managing ${w.name}? Type the name to confirm (the folder stays untouched)`, '');
        if (conf !== w.name) { if (conf !== null) showToast(t('home.notCancelled')); return; }
        const r = await api('/api/worlds/unmanage', { method: 'POST', body: { id: w.id, confirm: w.name } });
        showToast(t(r.mode === 'unlinked' ? 'home.unmanagedLinked' : 'home.unmanaged').replace('{n}', w.name));
        location.reload();
      }
    } catch (err) {
      showToast(String(err.message));
    }
  });
}

// 新建世界向导（功能设计 §1.2 · 第 88 轮：选择本地文件夹 → 文件夹名即世界名 → 介绍 + 封面）
// 目录/图片用**系统原生对话框**（服务端 osascript，浏览器拿不到本地路径）；
// 介绍 → README.md；封面图片 → 复制进 assets/（未来所有图片都住这个世界文件夹里）。
// 新建世界向导（功能设计 §1.2 · 第 88 轮选文件夹流 · **第 97 轮单页化**）：
// 原 3 步（文件夹 → 介绍/封面 → 摘要）→ **单页**：选文件夹即展开全部字段，填完直接创建，少两次跳页。
// 目录/图片仍用系统原生对话框（服务端 osascript，浏览器拿不到本地路径）。
function openNewWorld(root) {
  const zh = state.lang === 'zh-CN';
  const modal = document.createElement('div');
  modal.className = 'reader-modal active';
  modal.innerHTML = `
    <div class="modal-dialog settings-dialog">
      <div class="modal-header">
        <span class="eyebrow">${t('home.new.title')}</span>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="modal-scroll">
        <div class="wz-pick-row">
          <button class="button-primary" id="wz-pick">${t('wz.pick')}</button>
          <span class="field-note eyebrow">${t('wz.pickNote')}</span>
        </div>
        <div class="wz-picked" id="wz-picked" hidden></div>
        <div id="wz-fields" hidden>
          <label class="field"><span class="eyebrow">${t('wz.intro')}</span>
            <textarea class="text-input" name="intro" rows="3"></textarea></label>
          <div class="field-note eyebrow" id="wz-readme-note" hidden>${t('wz.readmeNote')}</div>
          <label class="field"><span class="eyebrow">${t('wz.cover')}</span>
            <span class="wz-cover-row">
              <button class="button-ghost" id="wz-cover-pick">${t('wz.pickImage')}</button>
              <span class="wz-cover-preview" id="wz-cover-preview" hidden><img id="wz-cover-thumb" alt=""><span class="wz-cover-name" id="wz-cover-name"></span><button class="button-ghost" id="wz-cover-clear">${t('wz.remove')}</button></span>
              <span class="field-note eyebrow" id="wz-cover-none">${t('wz.optional')}</span>
            </span></label>
          <details class="wz-adv">
            <summary class="eyebrow">${t('wz.advanced')}</summary>
            <label class="field"><span class="eyebrow">${t('wz.calendar')}</span>
              <input class="text-input" name="calendar" placeholder="CE 元年=0705"></label>
            <label class="field"><span class="eyebrow">${t('wz.timeline')}</span>
              <textarea class="text-input wz-timeline" name="timeline" rows="5" placeholder="&s 0705.01.01 &e 0705.12.31 &f 纪元开启 黄金纪元&#10;&s 0874.*.* &e 0874.*.* &f 灾变 大崩坏"></textarea></label>
          </details>
        </div>
        <div class="modal-actions">
          <button class="button-ghost" data-close>${t('ui.cancel')}</button>
          <button class="button-primary" id="wz-create" disabled>${t('wz.create')}</button>
        </div>
        <p class="modal-error" hidden></p>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const err = modal.querySelector('.modal-error');
  const showErr = (m) => { err.hidden = false; err.textContent = m; };
  const clearErr = () => { err.hidden = true; };
  const val = (n) => modal.querySelector(`[name=${n}]`)?.value.trim() || '';
  const createBtn = modal.querySelector('#wz-create');

  let picked = null;   // inspect 结果：{ path, name, mdCount, hasReadme, hasGit, insideLibrary, alreadyRegistered }
  let cover = null;    // { path, name, dataUrl? }

  const renderPicked = () => {
    const box = modal.querySelector('#wz-picked');
    if (!picked) { box.hidden = true; modal.querySelector('#wz-fields').hidden = true; createBtn.disabled = true; return; }
    const loc = abbrevPath(picked.path, homeMeta.home);
    const bits = [];
    bits.push(picked.mdCount ? t('wz.mdCount').replace('{n}', picked.mdCount) : t('wz.emptyFolder'));
    if (picked.hasReadme) bits.push(t('wz.hasReadme'));
    if (picked.hasGit) bits.push('git');
    if (!picked.insideLibrary) bits.push(t('wz.outside'));
    box.hidden = false;
    box.innerHTML = `
      <div class="set-row"><span class="eyebrow">${t('wz.nameFrom')}</span><b>${escapeHtml(picked.name)}</b></div>
      <div class="set-row"><span class="eyebrow">${t('detail.location')}</span><span class="wz-path" title="${escapeHtml(picked.path)}">${escapeHtml(loc)}/</span></div>
      <div class="set-row"><span class="eyebrow">${t('wz.folder')}</span><span>${escapeHtml(bits.join(' · '))}</span></div>`;
    // 选中文件夹 → 展开全部字段 + 允许创建（第 97 轮单页核心）
    modal.querySelector('#wz-fields').hidden = false;
    createBtn.disabled = false;
    const introEl = modal.querySelector('[name=intro]');
    introEl.disabled = !!picked.hasReadme;
    modal.querySelector('#wz-readme-note').hidden = !picked.hasReadme;
  };

  const renderCover = () => {
    const prev = modal.querySelector('#wz-cover-preview');
    const none = modal.querySelector('#wz-cover-none');
    if (!cover) { prev.hidden = true; none.hidden = false; return; }
    prev.hidden = false;
    none.hidden = true;
    const img = modal.querySelector('#wz-cover-thumb');
    if (cover.dataUrl) { img.src = cover.dataUrl; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
    modal.querySelector('#wz-cover-name').textContent = cover.name;
  };

  // 选择文件夹（系统原生对话框 → 返回绝对路径 → 预检）——预检行即摘要，不再有第 3 步
  modal.querySelector('#wz-pick').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    clearErr();
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = t('wz.waiting');
    try {
      const r = await api('/api/pick/folder', { method: 'POST', body: {} });
      if (!r.ok) return;   // 已取消：静默（对话框自己就是反馈）
      picked = await api('/api/worlds/inspect', { method: 'POST', body: { dir: r.path } });
      renderPicked();
    } catch (e) { showErr(e.message); }
    finally { btn.disabled = false; btn.textContent = old; }
  });

  // 选择封面（原生文件对话框 → dataUrl 缩略图；创建时复制进 assets/）
  modal.querySelector('#wz-cover-pick').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    clearErr();
    btn.disabled = true;
    try {
      const r = await api('/api/pick/file', { method: 'POST', body: { default: picked?.path || '' } });
      if (!r.ok) return;
      cover = { path: r.path, name: r.name, dataUrl: r.dataUrl };
      renderCover();
    } catch (e) { showErr(e.message); }
    finally { btn.disabled = false; }
  });
  modal.querySelector('#wz-cover-clear').addEventListener('click', () => { cover = null; renderCover(); });

  // 创建（单页直达）
  createBtn.addEventListener('click', async () => {
    clearErr();
    if (!picked) { showErr(t('wz.chooseFirst')); return; }
    createBtn.disabled = true;
    try {
      const w = await api('/api/worlds/adopt', { method: 'POST', body: {
        dir: picked.path, intro: val('intro'), coverPath: cover?.path || '',
        calendar: val('calendar'), timeline: val('timeline'),
      } });
      close();
      location.hash = `#/w/${encodeURIComponent(w.id)}`;   // 直接进入新世界（列表回首页时自会刷新）
    } catch (e2) { showErr(e2.message); createBtn.disabled = false; }
  });
}
