// 第 106 轮（优化计划 P3）：端到端 API 冒烟——spawn 真实服务（PORT=0 临时端口）+ 临时世界库，
// 固化历轮「手工 curl 验证」为可复跑的断言链：进世界流 / 409 乐观锁 / &r 排序 / 封面 / 双工具扫描 /
// 搜索双通道 / SSE 推送 / 静态资源（含 shared）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
let proc, base, worldsDir;
const W = encodeURIComponent('冒烟');

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  worldsDir = mkdtempSync(join(tmpdir(), 'soliterra-smoke-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: join(__dir, '..'),
    env: { ...process.env, PORT: '0', SOLITERRA_WORLDS: worldsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server 启动超时')), 8000);
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.on('exit', (c) => reject(new Error('server 意外退出 code=' + c)));
  });
});

after(() => {
  try { proc?.kill(); } catch { /* 已退 */ }
  rmSync(worldsDir, { recursive: true, force: true });
});

test('进世界流：create world → 建书(pair) → tree/entry 可读', async () => {
  const w = await api('/api/worlds', { method: 'POST', body: { name: '冒烟世界' } });
  assert.equal(w.status, 200);
  const b = await api(`/api/w/${encodeURIComponent('冒烟世界')}/fs/create`, { method: 'POST', body: { dir: 'books', name: '书一', pair: true } });
  assert.equal(b.body.path, 'books/书一.md');
  const t = await api(`/api/w/${encodeURIComponent('冒烟世界')}/tree`);
  const books = t.body.children.find((c) => c.name === 'books');
  assert.ok(books.children.some((c) => c.name === '书一'), '书出现在 books/ 下');
  const e = await api(`/api/w/${encodeURIComponent('冒烟世界')}/entry?path=README.md`);
  assert.equal(e.status, 200);
  assert.ok(e.body.mtime > 0, 'entry 带 mtime（乐观锁基准）');
});

test('409 乐观锁三态：外部改写→拒绝；force→覆盖；对齐→放行', async () => {
  const wid = encodeURIComponent('冒烟世界');
  await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/甲.md', text: 'v1\n', force: true } }).catch(() => {});
  await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books/书一', name: '甲', pair: false } });
  const e1 = await api(`/api/w/${wid}/entry?path=${encodeURIComponent('books/书一/甲.md')}`);
  const mtime = e1.body.mtime;
  await sleep(50);
  writeFileSync(join(worldsDir, '冒烟世界', 'books', '书一', '甲.md'), '外部改写\n', 'utf8');
  const r1 = await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/甲.md', text: '前端版本\n', baseMtime: mtime } });
  assert.equal(r1.status, 409, 'mtime 不符且未 force → 409');
  const r2 = await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/甲.md', text: '前端版本\n', baseMtime: mtime, force: true } });
  assert.equal(r2.status, 200);
  const r3 = await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/甲.md', text: '对齐版本\n', baseMtime: r2.body.mtime } });
  assert.equal(r3.status, 200, 'mtime 对齐放行');
});

test('&r 排序：fs/order 写序 → tree 按序输出', async () => {
  const wid = encodeURIComponent('冒烟世界');
  for (const n of ['乙', '丙']) await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books/书一', name: n, pair: false } });
  const r = await api(`/api/w/${wid}/fs/order`, { method: 'POST', body: { dir: 'books/书一', order: ['books/书一/丙.md', 'books/书一/甲.md', 'books/书一/乙.md'] } });
  assert.equal(r.body.updated, 3);
  const t = await api(`/api/w/${wid}/tree`);
  const node = t.body.children.find((c) => c.name === 'books').children.find((c) => c.name === '书一');
  assert.deepEqual(node.children.map((c) => c.name), ['丙', '甲', '乙'], 'tree 按 &r 顺序');
});

test('封面：世界外图片 → 复制进 assets/covers + &m 写入', async () => {
  const wid = encodeURIComponent('冒烟世界');
  const img = join(worldsDir, '外图.png');
  mkdirSync(worldsDir, { recursive: true });
  writeFileSync(img, 'PNG', 'utf8');
  const r = await api(`/api/w/${wid}/cover`, { method: 'POST', body: { path: 'README.md', image: img } });
  assert.equal(r.status, 200);
  assert.ok(r.body.cover.startsWith('assets/covers/'), '复制到 covers');
  const t = await api(`/api/w/${wid}/tree`);
  const readme = t.body.children.find((c) => c.name === 'README');
  assert.equal(readme.cover, r.body.cover, 'tree 反映封面');
});

test('工具扫描：symbols 报出全角符号行；date 两段补成三段', async () => {
  const wid = encodeURIComponent('冒烟世界');
  await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/符号.md', text: '&n 符号\n\n[[角色｜别名]]与“引号”。\n', force: true } });
  await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books/书一', name: '符号', pair: false } });
  await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/符号.md', text: '&n 符号\n\n[[角色｜别名]]与“引号”。\n', force: true } });
  const s = await api(`/api/w/${wid}/tools/scan?tool=symbols`);
  assert.ok(s.body.items.some((i) => i.after.includes('[[角色|别名]]')), '符号行报出且 after 正确');
  await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/日期.md', text: '&s 0705.9\n', force: true } });
  const d = await api(`/api/w/${wid}/tools/scan?tool=date`);
  assert.ok(d.body.items.some((i) => i.after.trim() === '&s 0705.09.*'), '两段补成三段');
});

test('搜索双通道：≥3 字 MATCH 带高亮；两字词 LIKE 命中', async () => {
  const wid = encodeURIComponent('冒烟世界');
  await api(`/api/w/${wid}/fs/create`, { method: 'POST', body: { dir: 'books/书一', name: '洛桑', pair: false } });
  await api(`/api/w/${wid}/save`, { method: 'POST', body: { path: 'books/书一/洛桑.md', text: '&n 洛桑学派\n\n洛桑学派主导北伐，三力通论为根基。\n', force: true } });
  const r1 = await api(`/api/w/${wid}/search?q=${encodeURIComponent('洛桑学派')}`);
  assert.equal(r1.body.length, 1);
  assert.ok(r1.body[0].snip.includes('<mark>洛桑学派</mark>'), 'MATCH snippet 高亮');
  const r2 = await api(`/api/w/${wid}/search?q=${encodeURIComponent('北伐')}`);
  assert.equal(r2.body.length, 1, '两字词 LIKE 通道');
  assert.ok(r2.body[0].snip.includes('<mark>北伐</mark>'));
});

test('SSE：订阅 events → 外部写文件 → 收到推送', async () => {
  const wid = encodeURIComponent('冒烟世界');
  const ac = new AbortController();
  const res = await fetch(`${base}/api/w/${wid}/events`, { signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  await reader.read();   // hello 帧
  writeFileSync(join(worldsDir, '冒烟世界', '推送触发.md'), '# 外部\n', 'utf8');
  let got = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !got.includes('推送触发.md')) {
    const r = await Promise.race([reader.read(), sleep(400).then(() => ({ timeout: true }))]);
    if (r.timeout) continue;
    if (r.done) break;
    got += dec.decode(r.value);
  }
  ac.abort();
  assert.ok(got.includes('推送触发.md'), '收到外部文件事件（awaitWriteFinish 300ms 内）');
});

test('静态资源：css/js/shared 可达、穿越拒绝', async () => {
  const css = await fetch(`${base}/css/app.css`);
  assert.equal(css.status, 200);
  const shared = await fetch(`${base}/shared/date.js`);
  assert.equal(shared.status, 200, 'shared 路由（第 95 轮）');
  const evil = await fetch(`${base}/w/${W}/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(evil.status, 404, '目录穿越拒绝');
});

test('详情保存端点：worldinfo 改名介绍 → entry 反映；bookinfo 成对改名 → tree 反映', async () => {
  const wid = encodeURIComponent('冒烟世界');
  const w1 = await api(`/api/w/${wid}/worldinfo`, { method: 'POST', body: { name: '冒烟显示名', intro: '详情面板写入的介绍。', calendar: 'CE=0705' } });
  assert.equal(w1.status, 200, 'worldinfo 保存');
  const e = await api(`/api/w/${wid}/entry?path=README.md`);
  assert.equal(e.body.meta.n?.[0], '冒烟显示名', '&n 反映');
  assert.ok(e.body.body.includes('详情面板写入的介绍'), '介绍落正文');
  assert.ok(e.body.body.includes('<!-- calendar: CE=0705 -->'), '历法注释落正文');
  const b1 = await api(`/api/w/${wid}/bookinfo`, { method: 'POST', body: { path: 'books/书一.md', name: '书一改', tags: '测试' } });
  assert.equal(b1.status, 200, 'bookinfo 保存');
  const t = await api(`/api/w/${wid}/tree`);
  const books = t.body.children.find((c) => c.name === 'books');
  assert.ok(books.children.some((c) => c.name === '书一改'), '树反映改名（成对）');
  const e2 = await api(`/api/w/${wid}/entry?path=${encodeURIComponent('books/书一改.md')}`);
  assert.deepEqual(e2.body.meta.t, ['测试'], '标签落 meta');
});
