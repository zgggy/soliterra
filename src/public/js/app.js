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
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
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
