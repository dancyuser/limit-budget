// Запуск виджета из исходников с любыми ключами, без зависимости от оболочки.
//
//   node scripts/start.mjs --proxy 10808
//   node scripts/start.mjs --proxy socks5://127.0.0.1:10808
//   node scripts/start.mjs --demo
//
// Зачем не `npm start -- --proxy 10808`: в PowerShell `npm` — это npm.ps1, а PowerShell проглатывает `--`,
// и ключ достаётся самому npm, а не программе. Здесь запускается обычный node.exe, ключи доходят как есть.
// Ключ --no-build пропускает сборку (если исходники не менялись).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const forwarded = args.filter((a) => a !== '--no-build');

if (!noBuild) {
  const build = spawnSync(process.execPath, [join(root, 'packages/app/scripts/build.mjs')], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const electronPath = require('electron');
const child = spawn(electronPath, [join(root, 'packages/app/dist/main.js'), ...forwarded], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
