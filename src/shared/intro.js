// 介绍首段读取（第 115 轮，前后端单点）：README/条目正文里「标题/元数据/日历注释之后的第一个非空块」。
// 前端（详情面板显示）与后端（vault 替换）同规则，避免读写口径漂移。
export function readIntro(body) {
  for (const b of String(body || '').split(/\n{2,}/)) {
    const s = b.trim();
    if (!s || /^#/.test(s) || /^&/.test(s) || /^<!--/.test(s)) continue;
    return s;
  }
  return '';
}
