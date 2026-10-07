// 第 109 轮（优化计划 P3-9 · UI 层）：playwright 关键流冒烟——headless chromium 自起服务（PORT=0），
// 与 API 层冒烟（test/smoke.test.js）互补。运行：npm run test:ui（需先 npx playwright install chromium）。
// 覆盖：进入流（默认面板→点书→目录）· 树拖拽中区移入（叶子配对）· 编辑自动保存落盘 ·
//       导出分组弹窗 · 条目封面头 hero · ⌘K 搜索。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const W = 'UI测';
let proc, base, worldsDir, browser, page;
const api = async (p, opts = {}) => {
  const res = await fetch(base + p, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  worldsDir = mkdtempSync(join(tmpdir(), 'soliterra-ui-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: join(__dir, '..'),
    env: { ...process.env, PORT: '0', SOLITERRA_WORLDS: worldsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server 启动超时')), 8000);
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
    proc.on('exit', (c) => reject(new Error('server 退出 code=' + c)));
  });
  // 播种：书A(甲乙=拖拽) · 书B(稿=编辑+封面+搜索) —— 互不干扰
  const wid = encodeURIComponent(W);
  await api('/api/worlds', { method: 'POST', body: { name: W } });
  await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books', name: '书A', pair: true } });
  await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books', name: '书B', pair: true } });
  for (const n of ['甲', '乙']) await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books/书A', name: n, pair: false } });
  await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books/书B', name: '稿', pair: false } });
  // 合法 1×1 PNG 封面（hero 测试要求 img 真实加载成功，否则 no-img 回退断言失败）
  writeFileSync(join(worldsDir, W, 'cv.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书B/稿.md', text: '&n 稿 &m cv.png\n\n# 稿\n\n洛桑学派北伐正文。\n', force: true } });
  // 纯目录节点（第 80 轮场景）：有子 md、无配对 md——点它应自动补建（第 111 轮）
  mkdirSync(join(worldsDir, W, 'books', '书A', '外来'), { recursive: true });
  writeFileSync(join(worldsDir, W, 'books', '书A', '外来', '子.md'), '# 子\n');
  await sleep(700);   // watcher 索引（awaitWriteFinish 300ms 余量）
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  try { await browser?.close(); } catch { /* 未启动 */ }
  try { proc?.kill(); } catch { /* 已退 */ }
  rmSync(worldsDir, { recursive: true, force: true });
});

// depth 用 padding-left（行是块级、rect.left 全相同；缩进在行内 padding）；
// **只取可见行**（hidden 子树内的行 offsetParent=null——否则收起状态也被统计）
const tocRows = () => page.$$eval('#toc-body .toc-row', (rows) => rows.filter((r) => r.offsetParent !== null).map((r) => ({
  label: r.querySelector('.toc-label')?.textContent?.trim() || '',
  top: Math.round(r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2),
  left: Math.round(r.getBoundingClientRect().left + r.getBoundingClientRect().width / 2),
  depth: parseInt(getComputedStyle(r).paddingLeft, 10) || 0,
})));

test('进入流：默认书籍面板 → 点书 → 目录树填充', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}`);
  await page.waitForSelector('.book-card', { timeout: 10000 });
  const panel = await page.$eval('#shell', (el) => el.className);
  assert.ok(panel.includes('p-books'), '首访默认书籍面板');
  await page.click('.book-card[data-name="书A"]');
  // 关键：初始树（README 行）也在 #toc-body——必须等**导航到位 + 书A 子树**出现，仅等 .toc-row 会立即满足
  await page.waitForFunction(() => location.hash.includes('books%2F%E4%B9%A6A.md') || location.hash.includes('books/书A.md'), { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#toc-body .toc-label')].some((e) => e.textContent.includes('甲')), { timeout: 6000 });
  const rows = await tocRows();
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes('书A') && labels.includes('甲') && labels.includes('乙'), `树含书A/甲/乙（实际 ${labels}）`);
  const panel2 = await page.$eval('#shell', (el) => el.className);
  assert.ok(panel2.includes('p-toc'), '点书切入目录面板');
});

test('树拖拽中区移入：甲 → 乙（乙变配对父，甲入其下）', async () => {
  const [ra, rb] = await tocRows();   // 甲、乙 同层（点书A后 rows=[书A,甲,乙] → 取后两个）
  const rows = await tocRows();
  const src = rows.find((r) => r.label === '甲'), dst = rows.find((r) => r.label === '乙');
  assert.ok(src && dst, '甲乙行在');
  await page.mouse.move(src.left, src.top);
  await page.mouse.down();
  await page.mouse.move((src.left + dst.left) / 2, (src.top + dst.top) / 2, { steps: 4 });
  await page.mouse.move(dst.left, (dst.top + dst.top) / 2, { steps: 4 });   // 目标中区
  await page.mouse.up();
  await page.waitForTimeout(1800);   // fs/move + 树重建
  // 展开乙（点行 = 打开+展开，第 111 轮语义）→ 甲应作为其子出现且缩进更深
  await page.click('#toc-body .toc-row:has(.toc-label:text-is("乙"))');
  await page.waitForFunction(() => [...document.querySelectorAll('#toc-body .toc-label')].some((e) => e.textContent.includes('甲') && e.offsetParent !== null), { timeout: 4000 });
  const rows2 = await tocRows();
  const yiRow = rows2.find((r) => r.label === '乙'), jiaRow = rows2.find((r) => r.label === '甲');
  assert.ok(yiRow && jiaRow, '乙与其子甲均可见');
  assert.ok(jiaRow.depth > yiRow.depth, '甲缩进为乙的子节点');
  const t = await api(`/api/w/${encodeURIComponent(W)}/tree`);
  const bookA = t.body.children.find((c) => c.name === 'books').children.find((c) => c.name === '书A');
  const yi = bookA.children.find((c) => c.name === '乙');
  assert.ok(yi.children?.some((c) => c.name === '甲'), '服务端：甲在乙子树（乙成配对书）');
});

test('两段式点击（第 112 轮）：未选中点=打开保持展开 → 再点=收起 → 再点=展开', async () => {
  const before = await tocRows();
  const bl = before.map((r) => r.label);
  assert.ok(bl.includes('书A') && bl.includes('乙'), `前置树（实际 ${bl}）`);
  // ① 未选中+已展开 → 只打开、保持展开（第一次点击 = 选中）
  await page.click('#toc-body .toc-row:has(.toc-label:text-is("书A"))');
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes('books/书A.md'), { timeout: 6000 });
  await page.waitForFunction(() => (document.querySelector('.entry-title')?.textContent || '').trim() === '书A', { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#toc-body .toc-row')].filter((r) => r.offsetParent !== null).length > 1, { timeout: 4000 });
  // ② 已选中+已展开 → 收起（唯一收起时机；同文档不重载）
  await page.click('#toc-body .toc-row:has(.toc-label:text-is("书A"))');
  await page.waitForFunction(() => [...document.querySelectorAll('#toc-body .toc-row')].filter((r) => r.offsetParent !== null).length === 1, { timeout: 4000 });
  // ③ 已选中+已收起 → 展开
  await page.click('#toc-body .toc-row:has(.toc-label:text-is("书A"))');
  await page.waitForFunction(() => [...document.querySelectorAll('#toc-body .toc-row')].filter((r) => r.offsetParent !== null).length > 1, { timeout: 4000 });
  assert.equal((await page.$eval('.entry-title', (e) => e.textContent)).trim(), '书A', '文档保持打开');
});

test('纯目录节点点击：自动补建配对 md 并打开（层级必须 md+文件夹，第 111 轮）', async () => {
  await page.waitForFunction(() => [...document.querySelectorAll('#toc-body .toc-label')].some((e) => e.textContent.includes('外来') && e.offsetParent !== null), { timeout: 8000 });
  const rows = await tocRows();
  assert.ok(rows.some((r) => r.label === '外来'), '纯目录行（有子 md 无配对 md）在树中');
  await page.click('#toc-body .toc-row:has(.toc-label:text-is("外来"))');
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes('books/书A/外来.md'), { timeout: 8000 });
  await page.waitForSelector('.entry-title', { timeout: 6000 });
  assert.equal((await page.$eval('.entry-title', (e) => e.textContent)).trim(), '外来', '打开补建出的文档');
  const t = await api(`/api/w/${encodeURIComponent(W)}/tree`);
  const bookA = t.body.children.find((c) => c.name === 'books').children.find((c) => c.name === '书A');
  const wl = bookA.children.find((c) => c.name === '外来');
  assert.equal(wl?.md, 'books/书A/外来.md', '服务端：外来已成对（md + 文件夹）');
  assert.ok(wl?.children?.some((c) => c.name === '子'), '原子目录内容保留');
});

test('编辑自动保存：打字 → 状态条 Saved → 磁盘落盘', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}/${encodeURIComponent('books/书B/稿.md')}`);
  await page.waitForSelector('.entry-title', { timeout: 8000 });
  await page.click('#fab-edit');
  await page.waitForSelector('.cm-content', { timeout: 8000 });
  await page.click('.cm-content');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' UI存盘标记', { delay: 30 });
  await page.waitForFunction(() => (document.getElementById('edit-status')?.textContent || '').includes('Saved'), { timeout: 6000 });
  const raw = await api(`/api/w/${encodeURIComponent(W)}/raw?path=${encodeURIComponent('books/书B/稿.md')}`);
  assert.ok(raw.body.text.includes('UI存盘标记'), '磁盘含输入内容');
});

test('导出弹窗：单按钮 → 三分组 → 可关闭', async () => {
  await page.click('#fab-edit');   // 先退出编辑（若在）
  await page.waitForTimeout(600);
  await page.click('#fab-world');
  await page.waitForSelector('#wp-export', { timeout: 6000 });
  assert.ok(!(await page.$('#ex-doc-md')), '旧平铺按钮已移除');
  await page.click('#wp-export');
  await page.waitForSelector('.export-group', { timeout: 4000 });
  const groups = await page.$$eval('.export-group .eyebrow', (els) => els.map((e) => e.textContent.trim()));
  assert.equal(groups.length, 3, '三组标题');
  await page.click('.modal-dialog .modal-close');
  await sleep(300);
  assert.ok(!(await page.$('.export-group')), '弹窗可关');
});

test('条目封面头 hero：封面置顶 + 标题叠底 + 渐变 ×1.5', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}/${encodeURIComponent('books/书B/稿.md')}`);
  await page.waitForSelector('.entry-hero', { timeout: 8000 });
  const r = await page.$eval('.entry-hero', (hero) => {
    const foot = hero.querySelector('.entry-hero-foot');
    const vh = parseFloat(hero.style.getPropertyValue('--veil-h'));
    return {
      titleInFoot: !!hero.querySelector('.entry-hero-foot .entry-title'),
      white: getComputedStyle(hero.querySelector('.entry-title')).color,
      ratio: foot ? Math.round((vh / foot.getBoundingClientRect().height) * 100) / 100 : 0,
    };
  });
  assert.ok(r.titleInFoot, '标题在封面 foot 内');
  assert.equal(r.white, 'rgb(255, 255, 255)', '标题白字');
  assert.ok(Math.abs(r.ratio - 1.5) < 0.1, `渐变 ≈1.5×标题行高（实测 ${r.ratio}）`);
});

test('⌘K 搜索：快捷键 → 面板 → 中文查询出结果', async () => {
  await page.keyboard.press('ControlOrMeta+k');
  await page.waitForSelector('.search-dialog', { timeout: 4000 });
  await page.fill('.search-input', '洛桑');
  await page.waitForFunction(() => document.querySelectorAll('.search-row').length > 0, { timeout: 5000 });
  const hits = await page.$$eval('.search-row .entry-card-title', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(hits.includes('稿'), '搜索命中（trigram LIKE 通道）');
});
