// Soliterra 导出（功能设计 §15.2）：md / txt / EPUB（客户端最小 ZIP）/ PDF（打印视图）。
// 全部在客户端生成，零服务端新依赖；浏览器下载。

const enc = (s) => encodeURIComponent(s);

/* ---------- CRC32 + 最小 ZIP（STORED，不压缩） ---------- */
let CRC_T = null;
function crcTable() {
  if (CRC_T) return CRC_T;
  CRC_T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_T[n] = c >>> 0;
  }
  return CRC_T;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zipBuild：entries=[{name, bytes}] → STORED zip Blob。 */
export function zipBuild(entries) {
  const enc8 = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  for (const e of entries) {
    const nameBytes = enc8.encode(e.name);
    const data = e.bytes;
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
    ]);
    parts.push(local, nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + nameBytes.length + data.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const local = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset),
    ]);
    parts.push(local, c.nameBytes);
    offset += local.length + c.nameBytes.length;
  }
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - cdStart), ...u32(cdStart), ...u16(0),
  ]);
  parts.push(eocd);
  return new Blob(parts, { type: 'application/zip' });
}

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ---------- md / txt ---------- */
/** 子树条目先序遍历（paths）。 */
export function subtreePaths(node) {
  const out = [];
  const walk = (n) => { if (n.md) out.push(n.md); for (const c of n.children) walk(c); };
  walk(node);
  return out;
}

/** txt：md 粗清理（标题/强调/双链/删除线 → 纯文本；& 行保留为来源标注）。 */
export function mdToTxt(md) {
  return md
    .replace(/^&[a-z].*$/gm, (l) => `（${l.trim()}）`)
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t)
    .replace(/~~([^~]+)~~/g, '［已证伪］$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*>\s?/gm, '　')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

/* ---------- EPUB（EPUB3，STORED zip） ---------- */
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** buildEpub({ title, chapters:[{id, title, html}] }) → Blob */
export function buildEpub({ title, chapters }) {
  const enc8 = new TextEncoder();
  const files = [{ name: 'mimetype', bytes: enc8.encode('application/epub+zip') }];
  files.push({ name: 'META-INF/container.xml', bytes: enc8.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`) });
  const chapFiles = chapters.map((c, i) => ({
    name: `OEBPS/ch${i + 1}.xhtml`,
    bytes: enc8.encode(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xmlEsc(c.title)}</title></head>
<body><h1>${xmlEsc(c.title)}</h1>${c.html}</body></html>`),
  }));
  files.push(...chapFiles);
  files.push({ name: 'OEBPS/nav.xhtml', bytes: enc8.encode(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head>
<body><nav epub:type="toc"><h1>目录</h1><ol>${chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${xmlEsc(c.title)}</a></li>`).join('')}</ol></nav></body></html>`) });
  files.push({ name: 'OEBPS/content.opf', bytes: enc8.encode(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:soliterra-${Date.now()}</dc:identifier>
    <dc:title>${xmlEsc(title)}</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${chapters.map((c, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine>${chapters.map((c, i) => `<itemref idref="ch${i + 1}"/>`).join('')}</spine>
</package>`) });
  return zipBuild(files);
}
