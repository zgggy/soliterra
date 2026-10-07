// 第 109 轮（优化计划 P3-9 · UI 层）：playwright 关键流冒烟——headless chromium 自起服务（PORT=0），
// 与 API 层冒烟（test/smoke.test.js）互补。运行：npm run test:ui（需先 npx playwright install chromium）。
// 覆盖：进入流（默认面板→点书→目录）· 树拖拽中区移入（叶子配对）· 编辑自动保存落盘 ·
//       导出分组弹窗 · 条目封面头 hero · ⌘K 搜索 · 首页卡同构/世界卡换位 · 书卡拖动幽灵。
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
  await api('/api/worlds', { method: 'POST', body: { name: W, subtitle: 'UI 测的世界简介首段，第 117 轮卡片同构断言用。' } });
  await api('/api/worlds', { method: 'POST', body: { name: '乙世界', subtitle: '乙世界的简介首段。' } });   // 首页拖动换位需 ≥2 卡
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
// 第 125 轮：刷新会恢复**各自上次的面板**（按世界 sessionStorage）——期望书籍面板的测试先归位
const ensureBooksPanel = async () => {
  await page.waitForSelector('.entry-title, .cm-content', { timeout: 8000 });   // 等渲染走完（面板恢复已定）
  if (await page.$('.books-head')) return;
  await page.click('#fab-books');
  await page.waitForSelector('.books-head', { timeout: 6000 });
};

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

test('批量建条目：空格分隔一次建多个（第 121 轮）', async () => {
  // 前序测试停在 书A/外来.md（目录面板）→ 面板头 ＋ 批量建三个
  await page.waitForSelector('#toc-add-entry', { timeout: 6000 });
  await page.click('#toc-add-entry');
  await page.waitForSelector('.ask-input', { timeout: 4000 });
  await page.fill('.ask-input', '批甲 "带 空格" 批乙 批丙');   // 第 122 轮：双引号名含空格
  await page.press('.ask-input', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.toc-label')].some((e) => e.textContent === '批丙' && e.offsetParent !== null), { timeout: 6000 });
  const rows = await tocRows();
  const labels = rows.map((r) => r.label);
  for (const n of ['批甲', '带 空格', '批乙', '批丙']) assert.ok(labels.includes(n), `树含 ${n}（实际 ${JSON.stringify(rows)}）`);
  const order = ['批甲', '带 空格', '批乙', '批丙'].map((n) => labels.indexOf(n));
  assert.ok(order.every((v2, i2) => i2 === 0 || v2 > order[i2 - 1]), `按输入顺序落层（实际 ${JSON.stringify(rows)}）`);
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

test('分屏预览滚动同步：两栏按比例互跟（第 121 轮）', async () => {
  // 前序测试停在 稿.md 编辑态——灌 40 行真实文本让两栏都可滚
  await page.click('.cm-content');
  await page.keyboard.press('ControlOrMeta+End');
  for (let i = 0; i < 40; i++) { await page.keyboard.type(`同步测试行第${i}行`); await page.keyboard.press('Enter'); }
  await page.click('.editor-shell [data-cmd="preview"]');   // 先开分屏（非分屏态滚动的是 reader-column）
  await page.waitForSelector('.editor-preview .entry-body', { timeout: 6000 });
  // 分屏后编辑器栏（editor-host / cm-scroller）必须自己可滚
  await page.waitForFunction(() => {
    const ed = ['#editor-host', '.cm-scroller'].map((s) => document.querySelector(s))
      .find((el) => el && el.scrollHeight > el.clientHeight + 300);
    return !!ed;
  }, null, { timeout: 8000 });
  await page.waitForFunction(() => {
    const pv = document.querySelector('.editor-preview');
    return pv && pv.scrollHeight > pv.clientHeight + 300;
  }, null, { timeout: 8000 });
  // 正向：编辑器滚到 60% → 预览按比例跟随
  const fwd = await page.evaluate(() => new Promise((res) => {
    const sc = ['#editor-host', '.cm-scroller'].map((s) => document.querySelector(s))
      .find((el) => el && el.scrollHeight > el.clientHeight + 10);
    const pv = document.querySelector('.editor-preview');
    const maxE = sc.scrollHeight - sc.clientHeight;
    const maxP = pv.scrollHeight - pv.clientHeight;
    sc.scrollTop = Math.round(maxE * 0.6);
    let tries = 0;
    const tick = () => {
      const got = maxP > 0 ? pv.scrollTop / maxP : -1;
      if (Math.abs(got - 0.6) < 0.06 || tries++ > 60) { res({ got, pvTop: pv.scrollTop, maxP }); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }));
  assert.ok(Math.abs(fwd.got - 0.6) < 0.06, `预览跟随 60%（实测 ${JSON.stringify(fwd)}）`);
  // 反向：预览滚到 30% → 编辑器跟随
  const bwd = await page.evaluate(() => new Promise((res) => {
    const sc = ['#editor-host', '.cm-scroller'].map((s) => document.querySelector(s))
      .find((el) => el && el.scrollHeight > el.clientHeight + 10);
    const pv = document.querySelector('.editor-preview');
    const maxE = sc.scrollHeight - sc.clientHeight;
    const maxP = pv.scrollHeight - pv.clientHeight;
    pv.scrollTop = Math.round(maxP * 0.3);
    let tries = 0;
    const tick = () => {
      const got = maxE > 0 ? sc.scrollTop / maxE : -1;
      if (Math.abs(got - 0.3) < 0.06 || tries++ > 60) { res({ got, edTop: sc.scrollTop, maxE }); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }));
  assert.ok(Math.abs(bwd.got - 0.3) < 0.06, `编辑器反向跟随 30%（实测 ${JSON.stringify(bwd)}）`);
  await page.click('.editor-shell [data-cmd="preview"]');   // 关分屏，还原后续测试环境
  await page.waitForTimeout(150);
});

test('快捷键：阅读态回车进编辑 · 编辑态 Esc 保存并退出（第 123 轮）', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}/${encodeURIComponent('books/书B/稿.md')}`);
  // 前序测试停在同条目编辑态（编辑保存/滚动同步）→ 先等任一态就位，编辑态则 fab 退回阅读
  await page.waitForSelector('.entry-title, .cm-content', { timeout: 8000 });
  if (await page.$('.cm-content')) {
    await page.click('#fab-edit');
    await page.waitForFunction(() => !document.querySelector('.cm-content'), null, { timeout: 6000 });
    await sleep(300);
  }
  await page.waitForSelector('.entry-title', { timeout: 8000 });
  assert.ok(!(await page.$('.cm-content')), '起始阅读态');
  await page.click('.entry-title');   // 焦点清到非打字上下文（h1 不可聚焦）
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.closest?.('.cm-editor'), null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest?.('.cm-editor')), '进编辑焦点在内容内（输入指示器）');
  await page.keyboard.type('回车进编辑标记', { delay: 15 });   // 不点不快捷键——焦点/光标文末是产品行为
  await page.waitForFunction(() => (document.getElementById('edit-status')?.textContent || '').includes('Saved'), null, { timeout: 6000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.cm-content'), null, { timeout: 6000 });
  const raw = await api(`/api/w/${encodeURIComponent(W)}/raw?path=${encodeURIComponent('books/书B/稿.md')}`);
  assert.ok(raw.body.text.endsWith('回车进编辑标记'), `Esc = 保存并退出 · 光标默认文末尾接（实际尾部 ${JSON.stringify(raw.body.text.slice(-20))}）`);
  // 方向键翻页（第 124 轮）：←↑ 上一篇 · →↓ 下一篇 · 编辑态不导航
  const h0 = await page.evaluate(() => location.hash);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction((h) => location.hash !== h, h0, { timeout: 5000 });
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((h) => location.hash === h, h0, { timeout: 5000 });
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((h) => location.hash !== h, h0, { timeout: 5000 });
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((h) => location.hash === h, h0, { timeout: 5000 });
  // 编辑态方向键 = 光标移动，不翻页
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.closest?.('.cm-editor'), null, { timeout: 5000 });
  const he = await page.evaluate(() => location.hash);
  await page.keyboard.press('ArrowDown');
  await sleep(400);
  assert.equal(await page.evaluate(() => location.hash), he, '编辑态方向键不翻页');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.cm-content'), null, { timeout: 6000 });
});

test('导出弹窗：单按钮 → 三分组 → 可关闭', async () => {
  if (await page.$('.cm-content')) {   // 先退出编辑（若在）——第 123 轮：无条件点在阅读态会反向进编辑
    await page.click('#fab-edit');
    await page.waitForTimeout(600);
  }
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
  if (await page.$('.cm-content')) {   // 编辑态 goto 会被条目切换闸挡住渲染（第 123 轮自防御）
    await page.click('#fab-edit');
    await page.waitForFunction(() => !document.querySelector('.cm-content'), null, { timeout: 6000 });
    await sleep(300);
  }
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
  // 搜索面板无关闭按钮（Esc 亦不收）→ 手动移除，否则 reader-modal 遮罩拦截后续测试的指针事件
  await page.evaluate(() => document.querySelectorAll('.reader-modal').forEach((m) => m.remove()));
});

// ---------- 第 117 轮：卡片统一——9:16 同构、信息入封面、title padding 归零、世界卡拖动换位 ----------
test('首页卡片同构 9:16 信息入封面 + 世界卡拖动换位落盘', async () => {
  await page.goto(`${base}/#/`);
  await page.evaluate(() => document.querySelectorAll('.reader-modal').forEach((m) => m.remove()));   // 防上游残留遮罩
  await page.waitForSelector('.world-card:not(.world-card-new)', { timeout: 10000 });
  const info = await page.$eval('.world-card:not(.world-card-new)', (c) => {
    const cover = c.querySelector('.card-cover');
    const title = cover?.querySelector('.card-title'), tag = cover?.querySelector('.card-tag');
    const r = cover.getBoundingClientRect();
    return {
      ratio: r.width / r.height,
      hasTitle: !!title, hasTag: !!tag,
      oldPath: !!c.querySelector('.world-card-path'), oldMeta: !!c.querySelector('.world-card-meta'),
      cardH: Math.round(c.getBoundingClientRect().height), coverH: Math.round(r.height),
      titlePad: title ? getComputedStyle(title).padding : null,
      titleEllipsis: title ? getComputedStyle(title).textOverflow : null,
    };
  });
  assert.ok(Math.abs(info.ratio - 9 / 16) < 0.005, `封面 9:16（实际 ${info.ratio.toFixed(3)}）`);
  assert.ok(info.hasTitle && info.hasTag, '标题 + 两行简介都在卡内');
  assert.ok(!info.oldPath && !info.oldMeta, '路径/统计行已按第 117 轮移除');
  assert.ok(Math.abs(info.cardH - info.coverH) <= 2, `卡高 ≈ 封面高（信息不外挂；${info.cardH} vs ${info.coverH}）`);
  assert.equal(info.titlePad, '0px', 'card-title padding 归零');
  // 拖动换位：卡0 → 卡1 右半（插后）→ DOM 换位 · 不跳转 · 刷新后保持（.order.json）
  const cards = await page.$$('.world-card:not(.world-card-new)');
  assert.ok(cards.length >= 2, `至少两张世界卡（实际 ${cards.length}）`);
  const id0 = await cards[0].getAttribute('data-id');
  const id1 = await cards[1].getAttribute('data-id');
  const b1 = await cards[1].boundingBox();
  await cards[0].hover();
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width * 0.9, b1.y + b1.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  assert.equal(await page.evaluate(() => location.hash), '#/', '拖完不进世界（点击守卫）');
  const idsA = await page.$$eval('.world-card:not(.world-card-new)', (cs) => cs.map((c) => c.dataset.id));
  assert.deepEqual(idsA.slice(0, 2), [id1, id0], 'DOM 换位（卡0 插到卡1 后）');
  await page.reload();
  await page.waitForSelector('.book-card, .world-card:not(.world-card-new)', { timeout: 10000 });
  await page.waitForSelector('.world-card:not(.world-card-new)', { timeout: 10000 });
  const idsB = await page.$$eval('.world-card:not(.world-card-new)', (cs) => cs.map((c) => c.dataset.id));
  assert.deepEqual(idsB.slice(0, 2), [id1, id0], '刷新后顺序保持（服务端落盘）');
});

test('书籍头合一 + filter 横滚（第 118/120 轮）', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}`);
  await ensureBooksPanel();
  await page.waitForSelector('.books-head', { timeout: 10000 });
  const head = await page.$eval('.books-head', (h) => ({
    titleGone: !h.textContent.includes('全部书籍'),
    countGone: !document.getElementById('books-count'),
    oneRow: !!h.querySelector('#books-filter') && !!h.querySelector('#books-add-book'),
    fade: getComputedStyle(h, '::after').backgroundImage.includes('linear-gradient'),
    fadePointer: getComputedStyle(h, '::after').pointerEvents,
  }));
  assert.ok(head.titleGone && head.countGone, '「全部书籍」「N 本」已删');
  assert.ok(head.oneRow, 'filter 与 ＋ 合并在同一行');
  assert.ok(head.fade && head.fadePointer === 'none', '右端渐变遮挡在且不挡指针');
  // 注满 chips → 纵向滚轮应映射成横向滚动（第 120 轮）。
  // 竞争（第 125 轮实测）：renderBooksPanel 的归档接口回来会整块重渲染、冲掉注入的 chips
  //（336/336）或让 wheel 打空（0→0）——「注入 → 量 → 滚」小循环，被冲掉就等一轮重来（≤3 次）。
  let st = null, left2 = 0;
  for (let i = 0; i < 3 && !left2; i++) {
    await page.evaluate(() => {
      const f = document.getElementById('books-filter');
      if (!f || f.children.length >= 40) return;
      for (let k = 0; k < 40; k++) {
        const b = document.createElement('button');
        b.className = 'bf-chip';
        b.textContent = '很长的分类标签' + k;
        f.appendChild(b);
      }
    });
    await sleep(150);
    st = await page.$eval('#books-filter', (f) => {
      const r = f.getBoundingClientRect();
      return { sw: f.scrollWidth, cw: f.clientWidth, left: f.scrollLeft, x: Math.round(r.x + Math.min(r.width / 2, 120)), y: Math.round(r.y + r.height / 2) };
    });
    if (!(st.sw > st.cw)) { await sleep(350); continue; }   // 刚被重渲染冲掉 → 等归档回调落定
    await page.mouse.move(st.x, st.y);
    await sleep(120);   // 命中测试落位（面板过渡中的 stale 坐标会打空）
    await page.mouse.wheel(0, 240);
    await sleep(220);
    left2 = await page.$eval('#books-filter', (f) => f.scrollLeft);
  }
  assert.ok(st.sw > st.cw, `chips 溢出可滚（${st.sw}/${st.cw}）`);
  assert.ok(left2 > st.left, `滚轮 → 横向滚动（${st.left} → ${left2}）`);
});

test('书卡拖动：幽灵带书名 + 中区前缀 + 三分区换位（第 117 轮：结构变更不丢名字）', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}`);
  await ensureBooksPanel();
  await page.waitForSelector('.book-card[data-name="书A"]', { timeout: 10000 });
  // 面板展开有宽度动画（过渡期仅 1 列 186px）——等全宽 2 列就位再量几何
  await page.waitForFunction(() => (document.getElementById('books-grid')?.parentElement?.getBoundingClientRect().width || 0) > 400, { timeout: 6000 });
  await sleep(300);
  const rect = (sel) => page.$eval(sel, (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const bA = await rect('.book-card[data-name="书A"]');
  const bB = await rect('.book-card[data-name="书B"]');
  assert.ok(bB.x > bA.x, '书B 在书A 右侧（两列网格）');
  const bk = await page.$eval('.book-card[data-name="书A"]', (c) => ({
    pad: getComputedStyle(c.querySelector('.card-title')).padding,
    border: getComputedStyle(c.querySelector('.card-cover')).borderBottomWidth,
    titleInCover: c.querySelector('.card-cover').contains(c.querySelector('.card-title')),
  }));
  assert.equal(bk.pad, '0px', '书卡 title padding 归零');
  assert.equal(bk.border, '0px', 'cover 无 border-bottom');
  assert.ok(bk.titleInCover, '标题在封面内');
  await page.mouse.move(bA.x + bA.w / 2, bA.y + bA.h / 2);
  await page.mouse.down();
  await page.mouse.move(bB.x + bB.w / 2, bB.y + bB.h / 2, { steps: 6 });   // 中区 = 移入
  await sleep(120);
  const g1 = await page.$eval('.toc-drag-ghost', (g) => g.textContent).catch(() => '');
  assert.equal(g1, '书B/书A', `中区幽灵 = 目标/原名（实际 ${g1}）`);
  await page.mouse.move(bB.x + bB.w * 0.9, bB.y + bB.h / 2, { steps: 4 });   // 右区 = 插后
  await sleep(120);
  const g2 = await page.$eval('.toc-drag-ghost', (g) => g.textContent).catch(() => '');
  assert.equal(g2, '书A', `离开中区还原原名（实际 ${g2}）`);
  const lineOn = await page.$eval('.card-drop-line', (l) => l.style.display === 'block').catch(() => false);
  assert.ok(lineOn, '插后间隙线显示');
  await page.mouse.up();
  await sleep(900);   // &r 重排 + 面板重绘
  const names = await page.$$eval('.book-card', (cs) => cs.map((c) => c.dataset.name));
  assert.deepEqual(names.slice(0, 2), ['书B', '书A'], `书A 插到书B 后（实际 ${names}）`);
});

test('暗色主题平台化：首页循环切换 → 刷新保持 → 世界内一致（第 121 轮）', async () => {
  await page.goto(`${base}/#/`);
  await page.waitForSelector('.world-card:not(.world-card-new)', { timeout: 8000 });
  // 循环最多 3 次必然经过 dark（light→dark→auto→light）
  for (let i = 0; i < 3; i++) {
    const th = await page.evaluate(() => localStorage.getItem('soliterra.theme'));
    if (th === 'dark') break;
    await page.click('#theme-switch');
    await sleep(120);
  }
  const on = await page.evaluate(() => ({
    theme: localStorage.getItem('soliterra.theme'),
    cls: document.body.classList.contains('dark-mode'),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(on.theme, 'dark', '平台档存 dark');
  assert.ok(on.cls, 'body.dark-mode 挂上');
  assert.equal(on.bg, 'rgb(20, 20, 20)', `暗色底生效（实际 ${on.bg}）`);
  // 刷新 → 启动即应用（首页保持暗色）
  await page.reload();
  await page.waitForSelector('.world-card:not(.world-card-new)', { timeout: 8000 });
  const afterReload = await page.evaluate(() => document.body.classList.contains('dark-mode'));
  assert.ok(afterReload, '刷新后首页仍暗色');
  // 进世界 → 一致（主题不再按世界分裂）
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}`);
  await ensureBooksPanel();
  await page.waitForSelector('.books-head', { timeout: 8000 });
  const inWorld = await page.evaluate(() => ({
    cls: document.body.classList.contains('dark-mode'),
    editorVar: getComputedStyle(document.body).getPropertyValue('--surface').trim(),
  }));
  assert.ok(inWorld.cls, '世界内仍暗色');
  assert.equal(inWorld.editorVar, '#1a1a1a', 'token 覆写到位（编辑器/阅读同源）');
  // 复位 light（不依赖环境）
  await page.evaluate(() => { localStorage.setItem('soliterra.theme', 'light'); document.body.classList.remove('dark-mode'); });
});

// ---------- 第 121 轮移动端走查：≤720 全屏浮层 / fab 可达 / 无横向溢出 / 弹窗贴边 ----------
test('移动端 375×667：面板全屏浮层 + fab 可点关面板 + 各态无横向溢出', async () => {
  await page.setViewportSize({ width: 375, height: 667 });
  try {
    const noHOverflow = async (tag) => {
      const o = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      assert.ok(o.sw <= o.cw + 1, `${tag} 无横向溢出（${o.sw}/${o.cw}）`);
    };
    await page.goto(`${base}/#/`);
    await page.waitForSelector('.world-card:not(.world-card-new)', { timeout: 8000 });
    await noHOverflow('首页');
    await page.goto(`${base}/#/w/${encodeURIComponent(W)}`);
    await ensureBooksPanel();
    await page.waitForSelector('.books-head', { timeout: 8000 });
    await sleep(500);
    const panel = await page.evaluate(() => {
      const p = document.querySelector('.push-panel.live');
      const cs = p ? getComputedStyle(p) : null;
      return { pos: cs?.position, z: cs?.zIndex, w: p ? Math.round(p.getBoundingClientRect().width) : 0 };
    });
    assert.equal(panel.pos, 'fixed', '开面板 = 全屏浮层');
    assert.equal(panel.z, '70', '浮层层级 70');
    assert.equal(panel.w, 375, '浮层占满视口宽');
    await noHOverflow('面板态');
    // fab 在浮层(70)之上 → 可点关面板（第 121 轮修复前被隐形 aside/层级压住）
    await page.click('#fab-books', { timeout: 5000 });
    await sleep(350);
    assert.ok(!(await page.$('.push-panel.live')), 'fab 点击关闭全屏面板');
    await page.click('#fab-books');
    await sleep(350);
    await page.click('.book-card');
    await sleep(700);
    await page.click('#fab-toc');
    await sleep(300);
    await noHOverflow('阅读态');
    await page.click('#fab-edit');
    await sleep(700);
    const tb = await page.evaluate(() => {
      const el = document.getElementById('editor-toolbar');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    });
    assert.ok(tb && tb.left >= 0 && tb.right <= 376, `编辑工具条在视口内（${JSON.stringify(tb)}）`);
    await noHOverflow('编辑态');
    await page.keyboard.press('ControlOrMeta+k');
    await sleep(450);
    const dlg = await page.evaluate(() => {
      const d = document.querySelector('.search-dialog');
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    });
    assert.ok(dlg && dlg.left >= 0 && dlg.right <= 375, `⌘K 弹窗贴边不溢出（${JSON.stringify(dlg)}）`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelectorAll('.reader-modal').forEach((m) => m.remove()));
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// ---------- 第 125 轮：刷新保持面板（按世界 sessionStorage；无记录默认书籍） ----------
test('刷新保持面板：目录仍目录 · 关闭仍关 · 无记录默认书籍', async () => {
  await page.goto(`${base}/#/w/${encodeURIComponent(W)}/${encodeURIComponent('books/书A.md')}`);
  await page.waitForSelector('.entry-title', { timeout: 8000 });
  // A：开着目录面板 → 刷新仍是目录
  await page.click('#fab-toc');
  await sleep(400);
  assert.ok((await page.$eval('#shell', (e) => e.className)).includes('p-toc'), '起始目录面板');
  await page.reload();
  await page.waitForSelector('.entry-title', { timeout: 8000 });
  await sleep(300);
  const afterReload = await page.$eval('#shell', (e) => e.className);
  assert.ok(afterReload.includes('p-toc'), `刷新后仍目录面板（实际 ${afterReload}）`);
  assert.ok(await page.$('.push-panel.live'), '目录面板内容在');
  // B：关闭面板 → 刷新仍关
  await page.click('#fab-toc');
  await sleep(350);
  assert.ok(!(await page.$('.push-panel.live')), '起始关闭');
  await page.reload();
  await page.waitForSelector('.entry-title', { timeout: 8000 });
  await sleep(300);
  assert.ok(!(await page.$('.push-panel.live')), '刷新后仍关闭（保持现状）');
  // C：无记录（本世界首次进入语义）→ 默认书籍面板
  await page.evaluate(() => sessionStorage.removeItem('soliterra.panel.UI测'));
  await page.reload();
  await page.waitForSelector('.entry-title', { timeout: 8000 });
  await sleep(300);
  assert.ok((await page.$eval('#shell', (e) => e.className)).includes('p-books'), '无记录默认书籍');
});
