// icon.png (1024) -> icon.icns, só no macOS (sips + iconutil). Chamado por `npm run build`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const dir = fileURLToPath(new URL('.', import.meta.url));
const set = join(dir, 'icon.iconset');
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) for (const [suffix, px] of [['', s], ['@2x', s * 2]]) {
  execFileSync('sips', ['-z', String(px), String(px), join(dir, 'icon.png'), '--out', join(set, `icon_${s}x${s}${suffix}.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(dir, 'icon.icns')]);
rmSync(set, { recursive: true, force: true });
console.log('icon.icns ok');
