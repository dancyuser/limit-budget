// Рисует иконку приложения (build/icon.png, 256×256) тем же кодом, что и значок в трее.
// Запуск: node --experimental-strip-types scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gaugePng } from '../src/main/icon.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), gaugePng(256, 0.62, [78, 200, 130]));
console.log('иконка записана: build/icon.png');
