// 首页 · 世界列表（功能设计 §1）
// 横排竖卡 + hover 倾斜 + 滚轮左右滚动 + 「+」新建卡 + 新建向导。

import { api, t, state, bindCoverFallbacks, abbrevPath, copyText } from './app.js';

// 平台元信息（世界库根 + 家目录）：卡片「位置」行与新建向导目标预览共用（renderHome 时拉取）
let homeMeta = { worldsDir: '', home: '' };
function libraryShort() { return abbrevPath(homeMeta.worldsDir, homeMeta.home); }

export async function renderHome(root) {
  root.innerHTML = `
    <header class="home-masthead">
      <div class="masthead-inner">
        <span class="brandmark">
          <span class="brandmark-main">${t('app.name')}</span>
          <span class="brandmark-sub">WORLD ARCHIVE</span>
        </span>
        <span class="masthead-actions">
          <button class="icon-button" id="import-obsidian" title="${state.lang === 'zh-CN' ? '导入 Obsidian 库' : 'Import Obsidian vault'}">${state.lang === 'zh-CN' ? '导入 Obsidian' : 'Import Obsidian'}</button>
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
      <button class="world-card-menu" title="${state.lang === 'zh-CN' ? '世界操作' : 'World actions'}">⋯</button>
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
      showWorldMenu(e, w);
    });
  }

  const plus = document.createElement('button');
  plus.className = 'world-card world-card-new';
  plus.innerHTML = `<span class="plus-glyph">+</span><span class="eyebrow">${t('home.new')}</span>`;
  plus.addEventListener('click', () => openNewWorld(root, () => routeRefresh()));
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

  function routeRefresh() { import('./app.js').then((m) => m.navigate('#/')); setTimeout(() => location.reload(), 50); }

  // Obsidian 导入（§15.6）：输入库绝对路径 + 世界名 → 复制为新世界
  root.querySelector('#import-obsidian')?.addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.className = 'reader-modal active';
    modal.innerHTML = `
      <div class="modal-dialog settings-dialog">
        <div class="modal-header">
          <span class="eyebrow">${state.lang === 'zh-CN' ? '导入 Obsidian 库' : 'Import Obsidian vault'}</span>
          <button class="modal-close" data-close>×</button>
        </div>
        <div class="modal-scroll">
          <label class="field"><span class="eyebrow">${state.lang === 'zh-CN' ? '库路径（本机绝对路径）' : 'Vault path (absolute)'}</span>
            <input class="text-input" name="src" placeholder="/Users/me/Documents/MyVault" autofocus></label>
          <label class="field"><span class="eyebrow">${state.lang === 'zh-CN' ? '新世界名' : 'New world name'}</span>
            <input class="text-input" name="name" placeholder="${state.lang === 'zh-CN' ? '如：我的知识库' : 'e.g. MyVault'}"></label>
          <div class="field-note eyebrow" style="color:var(--text-muted)">${state.lang === 'zh-CN' ? 'frontmatter → & 元数据 · 双链原样 · 图片入 assets/imported · 生成世界副本（不动原库）' : 'frontmatter → & metadata · wikilinks kept · images → assets/imported'}</div>
          <div class="modal-actions">
            <button class="button-ghost" data-close>${state.lang === 'zh-CN' ? '取消' : 'Cancel'}</button>
            <button class="button-primary" data-import>${state.lang === 'zh-CN' ? '导入' : 'Import'}</button>
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
async function showWorldMenu(e, w) {
  document.querySelectorAll('.tree-menu').forEach((m) => m.remove());
  const { askText } = await import('./world.js');
  const zh = state.lang === 'zh-CN';
  const dirFull = w.dir || '';
  const dirShow = dirFull ? abbrevPath(dirFull, homeMeta.home) + '/' : '';
  const menu = document.createElement('div');
  menu.className = 'tree-menu';
  menu.innerHTML = `
    ${dirShow ? `<div class="tree-menu-note" title="${escapeHtml(dirFull)}">${escapeHtml(dirShow)}</div>
    <button class="tree-menu-item" data-k="reveal">${zh ? '在 Finder 中显示' : 'Reveal in Finder'}</button>
    <button class="tree-menu-item" data-k="copy">${zh ? '复制完整路径' : 'Copy full path'}</button>
    <div class="tree-menu-sep"></div>` : ''}
    <button class="tree-menu-item" data-k="rename">${zh ? '重命名世界' : 'Rename'}</button>
    <button class="tree-menu-item" data-k="dup">${zh ? '复制世界' : 'Duplicate'}</button>
    <button class="tree-menu-item" data-k="del">${zh ? '删除世界（回收站）' : 'Delete (trash)'}</button>`;
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
      if (k === 'reveal') {
        await api('/api/worlds/reveal', { method: 'POST', body: { id: w.id } });
      } else if (k === 'copy') {
        const ok = await copyText(dirFull);
        showToastLike(ok ? (zh ? '已复制路径' : 'Path copied') : (zh ? '复制失败' : 'Copy failed'));
      } else if (k === 'rename') {
        const nn = await askText(state.lang === 'zh-CN' ? '新世界名' : 'New world name', w.name);
        if (!nn || !nn.trim() || nn.trim() === w.name) return;
        await api('/api/worlds/rename', { method: 'POST', body: { id: w.id, newName: nn.trim() } });
        location.reload();
      } else if (k === 'dup') {
        const nn = await askText(state.lang === 'zh-CN' ? '副本名' : 'Copy name', `${w.name} 副本`);
        if (!nn || !nn.trim()) return;
        await api('/api/worlds/duplicate', { method: 'POST', body: { id: w.id, newName: nn.trim() } });
        location.reload();
      } else if (k === 'del') {
        const conf = await askText(state.lang === 'zh-CN' ? `删除「${w.name}」？输入世界名完全一致以确认` : `Type the world name to confirm deleting ${w.name}`, '');
        if (conf !== w.name) { if (conf !== null) showToastLike(state.lang === 'zh-CN' ? '未确认，未删除' : 'Not confirmed'); return; }
        await api('/api/worlds/delete', { method: 'POST', body: { id: w.id, confirm: w.name } });
        location.reload();
      }
    } catch (err) {
      showToastLike(String(err.message));
    }
  });
}

function showToastLike(text) {
  const t2 = document.createElement('div');
  t2.className = 'toast toast-warning';
  t2.textContent = text;
  document.body.appendChild(t2);
  setTimeout(() => { t2.classList.add('out'); setTimeout(() => t2.remove(), 300); }, 3600);
}

// 新建世界向导（功能设计 §1.2：三步纸面）
function openNewWorld(root, done) {
  const modal = document.createElement('div');
  modal.className = 'reader-modal active';
  modal.innerHTML = `
    <div class="modal-dialog settings-dialog">
      <div class="modal-header">
        <span class="eyebrow">${t('home.new.title')} · <span id="wz-step">1/3</span></span>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="modal-scroll">
        <div class="wz-pane" data-step="1">
          <label class="field"><span class="eyebrow">${t('home.new.name')}</span>
            <input class="text-input" name="name" placeholder="${t('home.new.name.ph')}" autofocus></label>
          <div class="field-note eyebrow" id="wz-target"></div>
          <label class="field"><span class="eyebrow">${t('home.new.subtitle')}</span>
            <input class="text-input" name="subtitle"></label>
          <label class="field"><span class="eyebrow">${state.lang === 'zh-CN' ? '封面（assets/ 相对路径，可空）' : 'Cover (assets/ path, optional)'}</span>
            <input class="text-input" name="cover" placeholder="assets/concepts/cover.png"></label>
        </div>
        <div class="wz-pane" data-step="2" hidden>
          <label class="field"><span class="eyebrow">${state.lang === 'zh-CN' ? '历法与纪元锚点（注释写入根条目，可空）' : 'Calendar (root entry comment)'}</span>
            <input class="text-input" name="calendar" placeholder="CE 元年=0705"></label>
          <label class="field"><span class="eyebrow">${state.lang === 'zh-CN' ? '时间线（每行一个事件，可空；创建为「时间线/」子条目）' : 'Timeline (one event per line → entries)'}</span>
            <textarea class="text-input wz-timeline" name="timeline" rows="7" placeholder="&s 0705.01.01 &e 0705.12.31 &f 纪元开启 黄金纪元&#10;&s 0874.*.* &e 0874.*.* &f 灾变 大崩坏"></textarea></label>
        </div>
        <div class="wz-pane" data-step="3" hidden>
          <div class="wz-summary" id="wz-summary"></div>
        </div>
        <div class="modal-actions">
          <button class="button-ghost" id="wz-prev" hidden>${state.lang === 'zh-CN' ? '上一步' : 'Back'}</button>
          <button class="button-primary" id="wz-next">${state.lang === 'zh-CN' ? '下一步' : 'Next'}</button>
        </div>
        <p class="modal-error" hidden></p>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const val = (n) => modal.querySelector(`[name=${n}]`)?.value.trim() || '';
  // 存储位置预览（第 87 轮）：世界落在世界库下 <库>/<世界名>/——随名称输入实时反映
  const libShort = libraryShort();
  const targetPath = () => (libShort ? `${libShort}/${val('name') || '…'}/` : '');
  const updateTarget = () => {
    const el = modal.querySelector('#wz-target');
    if (!el) return;
    el.hidden = !libShort;
    el.innerHTML = libShort
      ? `${state.lang === 'zh-CN' ? '将创建于' : 'Will be created at'} <span class="wz-path">${escapeHtml(targetPath())}</span>`
      : '';
  };
  modal.querySelector('[name=name]').addEventListener('input', updateTarget);
  updateTarget();
  let step = 1;
  const show = () => {
    modal.querySelectorAll('.wz-pane').forEach((p) => { p.hidden = +p.dataset.step !== step; });
    modal.querySelector('#wz-step').textContent = `${step}/3`;
    modal.querySelector('#wz-prev').hidden = step === 1;
    const next = modal.querySelector('#wz-next');
    if (step < 3) { next.textContent = state.lang === 'zh-CN' ? '下一步' : 'Next'; }
    else { next.textContent = t('home.new.submit'); }
    if (step === 3) {
      const events = val('timeline').split('\n').filter((x) => x.trim()).length;
      modal.querySelector('#wz-summary').innerHTML = `
        <div class="set-row"><span class="eyebrow">${t('home.new.name')}</span><b>${escapeHtml(val('name'))}</b></div>
        ${libShort ? `<div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '位置' : 'Location'}</span><span>${escapeHtml(targetPath())}</span></div>` : ''}
        <div class="set-row"><span class="eyebrow">${t('home.new.subtitle')}</span><span>${escapeHtml(val('subtitle')) || '—'}</span></div>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '封面' : 'Cover'}</span><span>${escapeHtml(val('cover')) || '—'}</span></div>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '历法' : 'Calendar'}</span><span>${escapeHtml(val('calendar')) || '—'}</span></div>
        <div class="set-row"><span class="eyebrow">${state.lang === 'zh-CN' ? '时间线事件' : 'Events'}</span><b>${events}</b></div>`;
    }
  };
  modal.querySelector('#wz-prev').addEventListener('click', () => { step = Math.max(1, step - 1); show(); });
  modal.querySelector('#wz-next').addEventListener('click', async () => {
    if (step === 1) {
      if (!val('name')) { const err = modal.querySelector('.modal-error'); err.hidden = false; err.textContent = state.lang === 'zh-CN' ? '世界名必填' : 'Name required'; return; }
      modal.querySelector('.modal-error').hidden = true;
      step = 2; show(); return;
    }
    if (step === 2) { step = 3; show(); return; }
    try {
      await api('/api/worlds', { method: 'POST', body: {
        name: val('name'), subtitle: val('subtitle'), cover: val('cover'),
        calendar: val('calendar'), timeline: val('timeline'),
      } });
      close();
      done();
    } catch (e2) {
      const err = modal.querySelector('.modal-error');
      err.hidden = false; err.textContent = e2.message;
    }
  });
  show();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
