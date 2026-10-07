// Soliterra 工具箱（第 105 轮拆分自 world.js）：lint/修复工具的扫描→diff→apply 面板与
// 跳转批注（打开条目并框出错误行）。阅读入口经 hooks.openEntry 回调（避免 import 环）。
import { api, t, state, navigate } from './app.js';
import { enc, esc, showToast, lt, askText, checkHTML, bindChecks, openPaperDialog2, attachScrollIndicators } from './ui.js';
import { hooks, worldDataCache, refreshGitStatus, refreshTimeline } from './world-core.js';

// ============ 工具箱跳转批注：打开条目并把错误处框起来（类似批注） ============
function openWithAnnotation(ctx, path, rawLine) {
  const needle = String(rawLine || '').replace(/^\s*&[a-z]\s+/, '').trim();
  sessionStorage.setItem('soliterra.goto', JSON.stringify({ path, needle: needle.slice(0, 60) }));
  if (ctx.currentPath === path) annotateCurrent(ctx);
  else navigate(`#/w/${enc(ctx.worldId)}/${enc(path)}`);
}

/** 在当前已渲染的条目里找含 needle 片段的元素并框住（找不到则退回标题/元数据行）。 */
export function annotateCurrent(ctx) {
  const g = JSON.parse(sessionStorage.getItem('soliterra.goto') || 'null');
  if (!g) return;
  sessionStorage.removeItem('soliterra.goto');
  const entry = document.querySelector('.entry');
  if (!entry) return;
  const frag = (g.needle || '').slice(0, 12);
  let hit = null;
  if (frag) {
    const walk = (el2) => {
      for (const n of el2.childNodes) {
        if (n.nodeType === 3 && n.textContent.includes(frag)) { hit = n.parentElement; return; }
        if (n.nodeType === 1) { walk(n); if (hit) return; }
      }
    };
    walk(entry);
  }
  const target = (hit && hit !== entry) ? hit : (entry.querySelector('.entry-meta-top') || entry.querySelector('.entry-title') || entry);
  target.classList.add('doc-annotation');
  target.scrollIntoView({ block: 'center', behavior: 'auto' });
  setTimeout(() => target.classList.remove('doc-annotation'), 4000);
}

// ============ 工具箱（右 push 面板：扫描 → diff-row 预览 → 应用） ============
/** 工具按钮计数徽章（问题数在工具箱面板的功能按钮上，不在工具 fab 上）。
 *  lint 有 error→红、否则黄；修复类工具 = 待修复处数（中性）；0 隐藏。 */
function setToolBadge(modal, tool, items) {
  const b = modal.querySelector(`.tool-badge[data-badge="${tool}"]`);
  if (!b) return;
  const n = items.length;
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
  if (tool === 'lint') {
    const errs = items.filter((i) => i.severity === 'error').length;
    b.className = `tool-badge${errs ? ' err' : ' warn'}`;
  } else {
    b.className = 'tool-badge';
  }
}
/** 打开工具箱面板时并行预扫全部工具的计数（不阻塞当前工具列表）。 */
async function refreshToolBadges(ctx, modal) {
  const tools = ['lint', 'date', 'onboard', 'brackets', 'symbols', 'drift', 'images', 'regex', 'dup'];
  await Promise.all(tools.map(async (tk) => {
    try {
      const r = await api(`/api/w/${enc(ctx.worldId)}/tools/scan?tool=${tk}`);
      setToolBadge(modal, tk, r.items || []);
    } catch { /* 某工具扫描失败不阻塞其它徽章 */ }
  }));
}
export function renderTools(ctx) {
  const modal = document.getElementById('tools-host');
  if (!modal) return;
  modal.innerHTML = `
      <div class="tools-layout">
        <nav class="tools-nav">
          ${['lint', 'structure', 'date', 'onboard', 'brackets', 'symbols', 'drift', 'images', 'regex', 'dup'].map((tk, i) => `
          <button class="filter-button${i === 0 ? ' is-active' : ''}" data-tool="${tk}"><span>${lt(tk === 'lint' ? 'lintTitle' : ({ structure: 'toolStructure', date: 'toolDate', onboard: 'toolOnboard', brackets: 'toolBrackets', symbols: 'toolSymbols', drift: 'toolDrift', images: 'toolImages', regex: 'toolRegex', dup: 'toolDup' })[tk])}</span><span class="tool-badge" data-badge="${tk}" hidden></span></button>`).join('')}
        </nav>
        <div class="tools-main">
          <div class="tools-list" id="tools-list"><div class="loading">${lt('toolScanning')}</div></div>
          <div class="tools-foot">
            ${checkHTML(true, 'ALL', 'id="tools-all-row"')}
            <span class="tools-count" id="tools-count"></span>
            <button class="button-primary" id="tools-apply" disabled>${lt('toolApply')}</button>
          </div>
        </div>
      </div>`;
  attachScrollIndicators(modal);

  const list = modal.querySelector('#tools-list');
  const count = modal.querySelector('#tools-count');
  const applyBtn = modal.querySelector('#tools-apply');
  let currentTool = 'date';
  let items = [];

  function esc2(s2) { return esc(s2); }

  async function runScan(tool) {
    currentTool = tool;
    list.innerHTML = `<div class="loading">${lt('toolScanning')}</div>`;
    applyBtn.disabled = true;
    try {
      const params = tool === 'regex' && ctx.regexQ ? `&q=${enc(ctx.regexQ)}&r=${enc(ctx.regexR || '')}` : '';
      const r = await api(`/api/w/${enc(ctx.worldId)}/tools/scan?tool=${tool}${params}`);
      items = r.items.map((x) => ({ ...x, checked: true }));
      setToolBadge(modal, tool, items);        // 计数徽章跟随扫描结果
    } catch (e) { items = []; showToast(String(e.message || e), 'error'); }
    paint();
  }

  function paint() {
    const isLint = currentTool === 'lint';
    applyBtn.style.display = isLint ? 'none' : '';
    const allRow0 = modal.querySelector('#tools-all-row');
    if (allRow0) allRow0.style.display = isLint ? 'none' : '';
    if (isLint) {
      count.textContent = `${items.length}`;
      list.innerHTML = items.map((it) => `
        <div class="alert-row lint-${it.severity}" data-path="${esc(it.path)}" title="${lt('lintJump')}">
          <span class="lint-msg">${esc(it.message)}</span>
          <span class="lint-loc">${esc(it.path)}${it.line ? ':' + it.line : ''}</span>
        </div>`).join('');
      list.querySelectorAll('.alert-row[data-path]').forEach((row) => row.addEventListener('click', () => {
        const p2 = row.dataset.path;
        if (!p2) return;
        if (p2 === ctx.currentPath) return;
        navigate(`#/w/${enc(ctx.worldId)}/${enc(p2)}`);
      }));
      return;
    }
    if (!items.length) {
      list.innerHTML = `<div class="empty-state">${lt('toolNoIssues')}</div>`;
      count.textContent = '';
      applyBtn.disabled = true;
      return;
    }
    const fixRows = items.filter((x) => !x.manual);
    const manualRows = items.filter((x) => x.manual);
    list.innerHTML = [
      ...manualRows.map((it) => `<div class="alert-row lint-info"><span class="lint-msg">${esc2(it.before)}</span><span class="lint-loc">${esc2(String(it.path).slice(0, 60))}</span></div>`),
      ...fixRows.map((it, i) => it.kind === 'move' ? `
      <div class="diff-row diff-move">
        ${checkHTML(it.checked, '', `data-i="${i}"`)}
        <span class="diff-path diff-move-tag">${t('tools.moveTag')}</span>
        <span class="diff-before">${esc2(it.before)}</span>
        <span class="diff-arrow">→</span>
        <span class="diff-after">${esc2(it.after)}</span>
      </div>` : `
      <div class="diff-row">
        ${checkHTML(it.checked, '', `data-i="${i}"`)}
        <span class="diff-path" title="${esc2(it.src || it.path)}">${esc2(it.path)}:${it.line}</span>
        <span class="diff-before">${esc2(it.before)}</span>
        <span class="diff-arrow">→</span>
        <span class="diff-after">${esc2(it.after === '' ? '（删除此行）' : it.after)}</span>
      </div>`),
    ].join('');
    bindChecks(list);
    list.querySelectorAll('.check-row[data-i]').forEach((row) => row.addEventListener('click', () => {
      fixRows[+row.dataset.i].checked = row.classList.contains('on');
      refreshCount();
    }));
    // 点击行（勾选框以外）→ 打开条目，并把错误处用批注框标出
    list.querySelectorAll('.diff-row').forEach((row, i) => row.addEventListener('click', (e) => {
      if (e.target.closest('.check-row')) return;
      const it = fixRows[i];
      if (!it?.path || it.kind === 'move') return;   // 移动行不跳转
      openWithAnnotation(ctx, it.path, `${it.before || ''}`);
    }));
    refreshCount();
  }
  function refreshCount() {
    const fixRows = items.filter((x) => !x.manual);
    const n = fixRows.filter((x) => x.checked).length;
    count.textContent = `${n} / ${fixRows.length}`;
    applyBtn.disabled = n === 0;
  }

  modal.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', async () => {
    modal.querySelectorAll('[data-tool]').forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    if (b.dataset.tool === 'regex') {
      const q = await askText(lt('toolRegexFind'), ctx.regexQ || '');
      if (q === null) return;
      const r2 = await askText(lt('toolRegexRepl'), ctx.regexR || '');
      if (r2 === null) return;
      ctx.regexQ = q; ctx.regexR = r2;
    }
    runScan(b.dataset.tool);
  }));
  const allRow = modal.querySelector('#tools-all-row');
  bindChecks(modal);
  allRow.addEventListener('click', () => {
    const on = allRow.classList.contains('on');
    items.forEach((x) => { if (!x.manual) x.checked = on; });
    paint();
    const row = modal.querySelector('#tools-all-row');
    row.classList.toggle('on', on);
  });
  applyBtn.addEventListener('click', async () => {
    const chosen = items.filter((x) => x.checked && !x.manual);
    if (!chosen.length) return;
    applyBtn.disabled = true;
    try {
      const r = await api(`/api/w/${enc(ctx.worldId)}/tools/apply`, {
        method: 'POST', body: { tool: currentTool, items: chosen },
      });
      worldDataCache.delete(ctx.worldId);
      refreshGitStatus(ctx);
      await refreshTimeline(ctx);   // 工具改动（含日期归一等）即刻上轴
          showToast(`${lt('toolApplied')} ${r.changed} ${lt('toolPlaces')} · backup: ${r.backup}`, 'success');
      runScan(currentTool);
      // 刷新当前阅读内容（若被修改）——原地重载，不动面板
      if (chosen.some((x) => x.path === ctx.currentPath)) {
        await hooks.openEntry?.(ctx, ctx.currentPath, ctx.chrono);
      }
    } catch (e) {
      showToast(String(e.message), 'error');
      applyBtn.disabled = false;
    }
  });

  runScan('lint');
  refreshToolBadges(ctx, modal);               // 打开面板即并行预扫全部工具的计数徽章
}
