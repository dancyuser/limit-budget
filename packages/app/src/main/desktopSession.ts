// Запасной путь входа: тихо взять сессию из хранилища Claude Desktop (Windows, DPAPI + AES-256-GCM).
//
// ВЫКЛЮЧЕН по умолчанию (настройка desktopSessionFallback). Включается, только если собственная сессия виджета потеряна:
// расшифровка чужого хранилища хрупка и ломается при смене формата Chromium. Значения cookie не пишутся в логи и
// никуда не уходят; они кладутся только в профиль виджета (partition persist:claude).
// Криптография вынесена в чистые функции и проверена на синтетических данных; с реальным хранилищем Claude Desktop
// этот путь на шаге 0 нужно проверить отдельно (в том числе установку из Microsoft Store с виртуализированной папкой).
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileP = promisify(execFile);

/** Расшифровка значения cookie Chromium формата v10/v11: nonce 12 байт, затем шифртекст и тег GCM 16 байт. */
export function decryptChromiumCookie(blob: Buffer, key: Buffer): string {
  const prefix = blob.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    throw new Error(`Неподдерживаемый формат cookie (${prefix}); для v20 нужна App-Bound расшифровка`);
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const data = blob.subarray(15, blob.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** Ключ шифрования из Local State: base64, префикс «DPAPI», дальше блок, защищённый DPAPI пользователя. */
export function readProtectedKey(localState: string): Buffer {
  const j = JSON.parse(localState) as { os_crypt?: { encrypted_key?: string } };
  const b64 = j.os_crypt?.encrypted_key;
  if (!b64) throw new Error('В Local State нет os_crypt.encrypted_key');
  const raw = Buffer.from(b64, 'base64');
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('Ключ не защищён DPAPI');
  return raw.subarray(5);
}

async function dpapiUnprotect(protectedKey: Buffer): Promise<Buffer> {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$b=[Convert]::FromBase64String($env:LB_KEY); " +
    "$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); " +
    "[Convert]::ToBase64String($u)";
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, LB_KEY: protectedKey.toString('base64') },
    windowsHide: true,
  });
  return Buffer.from(stdout.trim(), 'base64');
}

export interface ImportedCookie {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

function candidateDirs(): string[] {
  const appdata = process.env.APPDATA ?? '';
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    join(appdata, 'Claude'),
    // Установка из Microsoft Store: данные в виртуализированной папке пакета.
    ...(local && existsSync(join(local, 'Packages'))
      ? ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_pzs8sxrjxfjjc'].map((p) => join(local, 'Packages', p, 'LocalCache', 'Roaming', 'Claude'))
      : []),
  ];
}

/** Читает cookie claude.ai из хранилища Claude Desktop. Возвращает null, если хранилище недоступно или формат не поддержан. */
export async function importClaudeDesktopCookies(log: (m: string) => void): Promise<ImportedCookie[] | null> {
  const dir = candidateDirs().find((d) => existsSync(join(d, 'Local State')));
  if (!dir) {
    log('Claude Desktop: каталог данных не найден');
    return null;
  }
  const dbCandidates = [join(dir, 'Network', 'Cookies'), join(dir, 'Cookies')];
  const src = dbCandidates.find((p) => existsSync(p));
  if (!src) {
    log('Claude Desktop: файл Cookies не найден');
    return null;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'lb-cookies-'));
  try {
    const copy = join(tmp, 'Cookies');
    try {
      copyFileSync(src, copy); // файл может быть заблокирован, пока приложение запущено
    } catch (e) {
      log(`Claude Desktop: не удалось скопировать Cookies (${(e as Error).message})`);
      return null;
    }
    const key = await dpapiUnprotect(readProtectedKey(readFileSync(join(dir, 'Local State'), 'utf8')));
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT host_key, name, path, is_secure, is_httponly, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai'")
        .all() as Array<Record<string, unknown>>;
      const out: ImportedCookie[] = [];
      for (const r of rows) {
        try {
          const value = decryptChromiumCookie(Buffer.from(r.encrypted_value as Uint8Array), key);
          out.push({
            name: String(r.name),
            value,
            host: String(r.host_key),
            path: String(r.path),
            secure: Number(r.is_secure) === 1,
            httpOnly: Number(r.is_httponly) === 1,
          });
        } catch (e) {
          log(`Claude Desktop: cookie ${String(r.name)} не расшифрована (${(e as Error).message})`);
        }
      }
      return out.length ? out : null;
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
