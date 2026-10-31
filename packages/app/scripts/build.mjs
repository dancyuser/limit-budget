// Сборка: main, preload и CLI — под Node (Electron), страницы — под браузер. Всё одним проходом esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', legalComments: 'none' };
const nodeOpts = { ...common, platform: 'node', format: 'cjs', target: 'node22' };

await Promise.all([
  build({ ...nodeOpts, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(dist, 'main.js'), external: ['electron'] }),
  build({ ...nodeOpts, entryPoints: [join(root, 'src/main/preload.ts')], outfile: join(dist, 'preload.js'), external: ['electron'] }),
  build({ ...nodeOpts, entryPoints: [join(root, 'src/cli/index.ts')], outfile: join(dist, 'cli.js') }),
  build({
    ...common,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    entryPoints: {
      widget: join(root, 'src/renderer/widget.ts'),
      dashboard: join(root, 'src/renderer/dashboard.ts'),
      login: join(root, 'src/renderer/login.ts'),
    },
    outdir: join(dist, 'renderer'),
  }),
]);

for (const f of ['widget.html', 'dashboard.html', 'login.html', 'styles.css']) {
  cpSync(join(root, 'src/renderer', f), join(dist, 'renderer', f));
}
console.log('сборка готова:', dist);
