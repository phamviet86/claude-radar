// Vẽ biểu tượng bằng mã (không cần công cụ ngoài): app icon 1024px (nền xanh đen, radar cyan) và biểu tượng thanh menu (template, đen trong suốt).
// Chạy: node desktop/make-icons.mjs  ->  desktop/icon.png, desktop/iconTemplate.png, desktop/iconTemplate@2x.png
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('.', import.meta.url));
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Dựng ảnh bằng hàm màu f(x, y) trong [0,1]²; lấy mẫu con 4x4 cho mép mịn. */
function render(size, f) {
  const out = Buffer.alloc(size * size * 4); const S = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = f((x + (sx + .5) / S) / size, (y + (sy + .5) / S) / size);
      if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
    }
    const n = S * S, o = (y * size + x) * 4;
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    out[o + 3] = Math.round((a / n) * 255);
  }
  return out;
}
const ring = (d, r, w) => Math.abs(d - r) < w / 2;
/** Radar: hai vòng, cánh quét và chấm. */
function radar(x, y, color, ringW) {
  const dx = x - .5, dy = y - .5, d = Math.hypot(dx, dy);
  if (ring(d, .30, ringW) || ring(d, .17, ringW)) return color;
  if (d < .045) return color;
  const along = (dx - dy) / Math.SQRT2, perp = Math.abs(dx + dy) / Math.SQRT2;
  if (along > 0 && along < .30 && perp < ringW * .45) return color;
  return null;
}
// app icon: ô vuông bo góc (kiểu macOS), nền gradient xanh đen, radar cyan
const app = render(1024, (x, y) => {
  const dx = Math.abs(x - .5) - .27, dy = Math.abs(y - .5) - .27, rr = .13;
  const inside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) < rr;
  if (!inside) return null;
  const glow = Math.max(0, 1 - Math.hypot(x - .5, y - .5) / .5);
  const bg = [Math.round(6 + 10 * glow), Math.round(16 + 34 * glow), Math.round(34 + 60 * glow), 1];
  return radar(x, y, [63, 224, 255, 1], .035) ?? bg;
});
writeFileSync(join(dir, 'icon.png'), png(1024, 1024, app));
// thanh menu: template (chỉ cần kênh alpha; macOS tự đổi màu theo giao diện sáng/tối)
for (const [name, s] of [['iconTemplate.png', 18], ['iconTemplate@2x.png', 36]]) {
  writeFileSync(join(dir, name), png(s, s, render(s, (x, y) => radar(x, y, [0, 0, 0, 1], s === 18 ? .11 : .09))));
}
console.log('ok');
