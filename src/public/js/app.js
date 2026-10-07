// Soliterra 前端入口 —— 路由 / i18n / API / 全局状态。
// 语言：locales/<tag>.json，缺词 fallback：所选 → en → key（功能设计 §15.5）

export const state = {
  lang: localStorage.getItem('soliterra.lang') || (navigator.language?.startsWith('zh') ? 'zh-CN' : 'en'),
  dict: {},
  fallback: {},
};

export async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText, body = {};
    try { body = await res.json(); msg = body.error || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status; err.body = body;   // 第 92 轮：乐观锁 409 等需要按状态码分流的调用方用
    throw err;
  }
  return res.json();
}

export function t(key) {
  return state.dict[key] ?? state.fallback[key] ?? key;
}

export async function setLang(lang) {
  state.lang = lang;
  localStorage.setItem('soliterra.lang', lang);
  document.documentElement.lang = lang;
  const [dict, fb] = await Promise.all([
    fetch(`/locales/${lang}.json`).then((r) => r.json()).catch(() => ({})),
    fetch('/locales/en.json').then((r) => r.json()).catch(() => ({})),
  ]);
  state.dict = dict;
  state.fallback = fb;
}

export function navigate(hash) { location.hash = hash; }

/** 路径缩写（第 87 轮「位置」显示）：家目录前缀 → `~`；不在家目录下则原样绝对路径。 */
export function abbrevPath(dir, home) {
  const p = String(dir || '');
  const h = String(home || '');
  return h && p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
}

/** 复制文本到剪贴板（第 87 轮「复制完整路径」）：clipboard API 失败 → textarea 兜底。 */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

/** 平台字体档（第 100 轮）：两档 = 中英文一起切换，localStorage 级（首页/世界/所有语言一致）。
 *  衬线 = 默认（平台英文也衬线）；无衬线 = 拉丁 Helvetica + 中文黑体。
 *  mono 旧档归入无衬线；覆写 --font-serif/--font-ui 两 token → 全站（含阅读区 --reading-font）跟随。 */
export function applyGlobalFont(font) {
  const sans = font === 'sans' || font === 'mono';   // mono（已废档）→ 无衬线
  const v = sans ? 'var(--stack-sans)' : 'var(--stack-serif)';
  document.documentElement.style.setProperty('--font-serif', v);
  document.documentElement.style.setProperty('--font-ui', v);
}
export function currentFont() { return localStorage.getItem('soliterra.font') === 'sans' ? 'sans' : 'serif'; }

/** 平台主题三态（第 121 轮平台化，与字体档同模式）：light / dark / auto。
 *  localStorage 级（首页/世界一致）；auto 跟随系统并实时响应偏好变化；
 *  body.dark-mode 类驱动全站 token 覆写（含编辑器——CM 主题全走 CSS 变量）。 */
export function applyGlobalTheme(theme) {
  localStorage.setItem('soliterra.theme', theme === 'light' || theme === 'dark' ? theme : 'auto');
  syncGlobalTheme();
}
export function currentTheme() {
  const v = localStorage.getItem('soliterra.theme');
  return v === 'light' || v === 'dark' ? v : 'auto';
}
function syncGlobalTheme() {
  const dark = currentTheme() === 'dark'
    || (currentTheme() === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark-mode', dark);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentTheme() === 'auto') syncGlobalTheme();
});

/** 封面图加载失败 → 替换为大大的首字母（不留破图占位符）。 */
export function bindCoverFallbacks(scope) {
  (scope || document).querySelectorAll('img[data-glyph]').forEach((img) => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = img.dataset.glyphClass || 'cov-glyph';
      span.textContent = img.dataset.glyph || '?';
      img.replaceWith(span);
    }, { once: true });
  });
}

// ---------- 路由 ----------
const root = document.getElementById('app');

async function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const parts = hash.split('/');
  if (parts[0] === 'w' && parts[1]) {
    const { renderWorld, currentWorld } = await import('./world.js');
    const aw = currentWorld();
    const path = parts.slice(2).join('/') || null;
    // 同世界导航：原地更新正文与相关面板，不整页重渲染（面板不闪）
    if (aw && aw.id === parts[1] && path) { if (await aw.update(path)) return; }
    root.innerHTML = '';
    renderWorld(root, parts[1], path);
  } else {
    const { leaveWorld } = await import('./world.js');
    leaveWorld();
    root.innerHTML = '';
    const { renderHome } = await import('./home.js');
    renderHome(root);
  }
}

window.addEventListener('hashchange', route);

(async () => {
  applyGlobalFont(currentFont());   // 第 100 轮：启动即应用平台字体档（首页也生效）
  applyGlobalTheme(currentTheme()); // 第 121 轮：启动即应用平台主题（首页也生效）
  await setLang(state.lang);
  if (!location.hash) location.hash = '#/';
  await route();
})();

// 语言切换按钮的全局委托（首页与操作栏共用）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lang-switch]');
  if (btn) {
    setLang(state.lang === 'zh-CN' ? 'en' : 'zh-CN').then(route);
  }
});
