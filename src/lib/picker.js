// 原生选择器（第 88 轮）——服务端弹系统对话框，拿绝对路径（浏览器拿不到本地路径）。
// macOS：osascript 的 choose folder / choose file（Standard Additions，无需辅助功能权限）。
// Linux：zenity / kdialog 尽力而为；其余平台明确报错，UI 降级提示。
// 对话框期间用异步 exec（不阻塞事件循环）；用户取消 → { canceled: true }（非错误）。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExec = promisify(execFile);

/** 取消判定（osascript 以 -128 退出并在 stderr 报 User canceled）——导出供测试。 */
export function isCancelError(err) {
  const msg = `${err?.stderr || ''} ${err?.message || ''}`;
  return /User canceled|-128|cancel(l)?ed/i.test(msg);
}

/** 选择结果归一：osascript 返回 POSIX 路径（目录带尾斜杠）→ 去尾斜杠与空白。 */
export function normalizePicked(stdout) {
  return String(stdout || '').trim().replace(/\/+$/, '');
}

const OSA = (script) => ['-e', script];

/** 目录选择：返回绝对路径。 */
export async function pickFolder({ prompt = '选择世界文件夹', defaultPath = '' } = {}) {
  if (process.platform === 'darwin') {
    const def = defaultPath ? ` default location (POSIX file ${JSON.stringify(defaultPath)})` : '';
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)}${def})`;
    try {
      const { stdout } = await pExec('osascript', OSA(script), { timeout: 600000 });
      return { ok: true, path: normalizePicked(stdout) };
    } catch (e) {
      if (isCancelError(e)) return { ok: false, canceled: true };
      throw new Error(`目录选择失败：${(e.stderr || e.message || '').trim()}`);
    }
  }
  if (process.platform === 'linux') {
    const args = ['--file-selection', '--directory', `--title=${prompt}`];
    if (defaultPath) args.push(`--filename=${defaultPath}/`);
    try {
      const { stdout } = await pExec('zenity', args, { timeout: 600000 });
      return { ok: true, path: normalizePicked(stdout) };
    } catch (e) {
      if (isCancelError(e) || e.code === 1) return { ok: false, canceled: true };
      try {
        const { stdout } = await pExec('kdialog', ['--getexistingdirectory', defaultPath || '.', '--title', prompt], { timeout: 600000 });
        return { ok: true, path: normalizePicked(stdout) };
      } catch (e2) {
        if (isCancelError(e2) || e2.code === 1) return { ok: false, canceled: true };
        throw new Error('本平台需要 zenity 或 kdialog 才能弹出目录选择器');
      }
    }
  }
  throw new Error('当前系统暂不支持原生目录选择（macOS 用 osascript；Linux 需 zenity/kdialog）');
}

/** 图片选择：返回绝对路径（限图片类型）。 */
export async function pickImage({ prompt = '选择封面图片', defaultPath = '' } = {}) {
  if (process.platform === 'darwin') {
    const def = defaultPath ? ` default location (POSIX file ${JSON.stringify(defaultPath)})` : '';
    const script = `POSIX path of (choose file with prompt ${JSON.stringify(prompt)} of type {"public.image"}${def})`;
    try {
      const { stdout } = await pExec('osascript', OSA(script), { timeout: 600000 });
      return { ok: true, path: normalizePicked(stdout) };
    } catch (e) {
      if (isCancelError(e)) return { ok: false, canceled: true };
      throw new Error(`图片选择失败：${(e.stderr || e.message || '').trim()}`);
    }
  }
  if (process.platform === 'linux') {
    const args = ['--file-selection', `--title=${prompt}`, '--file-filter=图片 | *.png *.jpg *.jpeg *.gif *.webp *.svg'];
    if (defaultPath) args.push(`--filename=${defaultPath}/`);
    try {
      const { stdout } = await pExec('zenity', args, { timeout: 600000 });
      return { ok: true, path: normalizePicked(stdout) };
    } catch (e) {
      if (isCancelError(e) || e.code === 1) return { ok: false, canceled: true };
      throw new Error('本平台需要 zenity 才能弹出图片选择器');
    }
  }
  throw new Error('当前系统暂不支持原生图片选择（macOS 用 osascript；Linux 需 zenity）');
}
