// Чтение настоящего каталога сессий Codex (ChatGPT Desktop, Codex CLI): ~/.codex/sessions/ГГГГ/ММ/ДД/rollout-*.jsonl.
//
// Логи большие (на живой машине: 109 файлов, около 520 МБ, самый большой 120 МБ), а опрос идёт раз в минуту, поэтому
// файлы целиком не читаются: берутся самые свежие файлы последних дней и только хвост каждого. Строка rate_limits пишется
// после каждого хода, так что последние десятки килобайт почти всегда содержат свежие лимиты. Хвост неизменившегося файла
// повторно не читается. Содержимое разговоров никуда не сохраняется и не показывается: дальше по цепочке идут только числа.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RolloutSource } from './chatgpt.js';

export interface CodexRolloutOptions {
  /** Каталог sessions. По умолчанию `$CODEX_HOME/sessions`, иначе `~/.codex/sessions`. */
  dir?: string;
  /** Сколько последних дней (каталогов ДД) просматривать. */
  recentDays?: number;
  /** Сколько самых свежих файлов читать. */
  maxFiles?: number;
  /** Сколько байт с конца каждого файла читать. */
  tailBytes?: number;
}

export function defaultCodexDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CODEX_HOME ? join(env.CODEX_HOME, 'sessions') : join(home, '.codex', 'sessions');
}

const ROLLOUT = /^rollout-.*\.jsonl$/;

async function subdirs(dir: string, name: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && name.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Хвост файла построчно. Если чтение началось не с начала файла, первая строка обрезана и отбрасывается. */
async function readTail(path: string, size: number, tailBytes: number): Promise<string[]> {
  const start = Math.max(0, size - tailBytes);
  const length = size - start;
  if (length <= 0) return [];
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    if (start > 0) lines.shift();
    return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
  } finally {
    await fh.close();
  }
}

export class CodexRolloutSource implements RolloutSource {
  readonly dir: string;
  private recentDays: number;
  private maxFiles: number;
  private tailBytes: number;
  private cache = new Map<string, { mtimeMs: number; size: number; lines: string[] }>();

  constructor(opts: CodexRolloutOptions = {}) {
    this.dir = opts.dir ?? defaultCodexDir();
    this.recentDays = opts.recentDays ?? 14;
    this.maxFiles = opts.maxFiles ?? 8;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
  }

  /** Свежие rollout-файлы: от старых к новым по времени последней записи. */
  async listFiles(): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
    const root = await stat(this.dir).catch(() => null);
    if (!root?.isDirectory()) {
      throw new Error(`Каталог логов Codex не найден: ${this.dir.replace(homedir(), '~')}. Запустите Codex хотя бы раз или задайте переменную CODEX_HOME`);
    }
    const dayDirs: string[] = [];
    outer: for (const y of await subdirs(this.dir, /^\d{4}$/)) {
      for (const m of await subdirs(join(this.dir, y), /^\d{2}$/)) {
        for (const d of await subdirs(join(this.dir, y, m), /^\d{2}$/)) {
          dayDirs.push(join(this.dir, y, m, d));
          if (dayDirs.length >= this.recentDays) break outer;
        }
      }
    }
    // На случай плоского каталога: файлы лежат прямо в sessions.
    dayDirs.push(this.dir);
    const found: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const dir of dayDirs) {
      const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => ROLLOUT.test(n));
      for (const name of names) {
        const path = join(dir, name);
        const st = await stat(path).catch(() => null);
        if (st?.isFile()) found.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.maxFiles).reverse();
  }

  async readFiles(): Promise<string[][]> {
    const files = await this.listFiles();
    const next = new Map<string, { mtimeMs: number; size: number; lines: string[] }>();
    const out: string[][] = [];
    for (const f of files) {
      const hit = this.cache.get(f.path);
      let lines: string[];
      if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
        lines = hit.lines;
      } else {
        // Файл мог исчезнуть или быть занят между просмотром каталога и чтением: пропускаем его, остальные читаем.
        lines = await readTail(f.path, f.size, this.tailBytes).catch(() => hit?.lines ?? []);
      }
      next.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, lines });
      out.push(lines);
    }
    this.cache = next;
    return out;
  }

  async readLines(): Promise<string[]> {
    return (await this.readFiles()).flat();
  }
}
