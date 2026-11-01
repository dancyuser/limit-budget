// Шаг 0: спайк по источникам данных на машине пользователя.
// Собирает обезличенные образцы и пишет отчёт data-sources.generated.md; его содержимое переносится в docs/data-sources.md
// с решением «берём» или «не берём» по каждому источнику. Тексты разговоров и значения cookie не читаются и не сохраняются.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_ORGS_PATH, CLAUDE_USAGE_PATH, parseUsage, pickOrganization, type PageFetcher } from '../providers/claude.js';
import { latestRateLimits, parseRateLimitsLine } from '../providers/chatgpt.js';
import type { SpikeResult } from '../shared/ipc.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[^\s"']+@[^\s"']+\.[^\s"']+/g;

/** Обезличивание: идентификаторы, почты и свободный текст заменяются метками, числа и служебные перечисления остаются. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8) return '<deep>';
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /name|email|phone|address|token|key|secret|session|cookie/i.test(k) ? '<redacted>' : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/.test(v)) return v; // метки времени нужны для проверки формы
    if (/^[a-z][a-z0-9_]{0,24}$/.test(v)) return v; // служебные перечисления: chat, claude_pro и т. п.
    const masked = v.replace(UUID, '<uuid>').replace(EMAIL, '<email>');
    return masked.length > 24 ? '<str>' : masked;
  }
  return v;
}

/**
 * Разбивка недели (`seven_day_breakdown.rows`): общий redact прячет и `key`, и `display_name`, поэтому по отчёту не видно,
 * на что поделён недельный расход. Подписи строк (название модели или продукта) не личные данные, их оставляем:
 * только короткие, без почт и идентификаторов.
 */
export function breakdownRows(json: unknown): Array<{ label: string; percent: number }> {
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const bd = root?.seven_day_breakdown;
  const rows = bd && typeof bd === 'object' ? (bd as Record<string, unknown>).rows : null;
  if (!Array.isArray(rows)) return [];
  const out: Array<{ label: string; percent: number }> = [];
  for (const r of rows.slice(0, 12)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const raw = typeof o.display_name === 'string' ? o.display_name : typeof o.key === 'string' ? o.key : '';
    const label = raw.replace(UUID, '<uuid>').replace(EMAIL, '<email>').trim();
    if (typeof o.percent !== 'number' || !label) continue;
    out.push({ label: label.length > 40 ? label.slice(0, 40) + '…' : label, percent: o.percent });
  }
  return out;
}

export interface SpikeDeps {
  fetcher: PageFetcher;
  describeCookies(): Promise<Array<{ name: string; session: boolean; httpOnly: boolean; expiresInDays: number | null }>>;
  hasSession(): Promise<boolean>;
  /** Строки о сети: какой прокси задан, что выбирает Chromium, ответ claude.ai и страна выхода. */
  networkReport(): Promise<{ lines: string[]; summary: string }>;
  outDir: string;
  log(m: string): void;
}

const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```\n';

async function claudeSection(d: SpikeDeps, summary: string[]): Promise<string> {
  let md = '## Claude: эндпоинт использования claude.ai\n\n';
  if (!(await d.hasSession())) {
    summary.push('Claude: входа нет — выполните «Войти в Claude» и повторите спайк');
    return md + 'Входа в claude.ai нет: сначала войдите в окне виджета («Войти в Claude» в меню трея) и повторите спайк.\n\n';
  }
  const t0 = Date.now();
  const orgs = await d.fetcher.fetchJson(CLAUDE_ORGS_PATH);
  md += `GET \`${CLAUDE_ORGS_PATH}\` → ${orgs.status} за ${Date.now() - t0} мс\n\n`;
  if (orgs.status !== 200) {
    summary.push(`Claude: список организаций вернул ${orgs.status}`);
    return md + (orgs.text ? '```\n' + orgs.text.slice(0, 300) + '\n```\n' : '');
  }
  md += json(redact(orgs.json));
  let org: string;
  try {
    org = pickOrganization(orgs.json);
  } catch (e) {
    summary.push(`Claude: ${(e as Error).message}`);
    return md + `Не удалось выбрать организацию: ${(e as Error).message}\n`;
  }
  const path = CLAUDE_USAGE_PATH.replace('{org}', org);
  const times: number[] = [];
  let last: { status: number; json: unknown; text?: string } | null = null;
  for (let i = 0; i < 3; i++) {
    const s = Date.now();
    last = await d.fetcher.fetchJson(path);
    times.push(Date.now() - s);
    if (last.status !== 200) break;
  }
  md += `\nGET \`${CLAUDE_USAGE_PATH}\` → ${last!.status}, три запроса подряд: ${times.join(', ')} мс\n\n`;
  if (last!.status === 200) {
    md += json(redact(last!.json));
    try {
      const snaps = parseUsage(last!.json);
      md += `Адаптер разобрал окна: ${snaps.map((s) => `${s.window}/${s.bucket}=${s.usedPct}`).join(', ')}.\n\n`;
      md += `Срезы по моделям на этом тарифе: ${snaps.filter((s) => s.bucket !== 'all').map((s) => s.bucket).join(', ') || 'нет'}.\n\n`;
      const rows = breakdownRows(last!.json);
      if (rows.length) {
        md += '### Разбивка недели (`seven_day_breakdown`)\n\n| строка | доля, % |\n|---|---|\n';
        for (const r of rows) md += `| ${r.label} | ${r.percent} |\n`;
        md += `\nСумма долей: ${rows.reduce((a, r) => a + r.percent, 0)}.\n\n`;
        summary.push(`Claude: разбивка недели — ${rows.map((r) => `${r.label} ${r.percent}%`).join(', ')}`);
      }
      summary.push(`Claude: usage OK (${snaps.length} окон), ответ ${times.at(-1)} мс`);
    } catch (e) {
      md += `**Форма ответа не совпала с адаптером:** ${(e as Error).message}\n\n`;
      summary.push(`Claude: форма ответа не совпала (${(e as Error).message})`);
    }
  } else {
    md += (last!.text ? '```\n' + last!.text.slice(0, 300) + '\n```\n' : '') + '\n';
    summary.push(`Claude: usage вернул ${last!.status}${last!.text && /just a moment/i.test(last!.text) ? ' (Cloudflare)' : ''}`);
  }

  const cookies = await d.describeCookies();
  md += '### Долговечность входа (значения cookie не сохраняются)\n\n| cookie | сессионная | httpOnly | срок, дней |\n|---|---|---|---|\n';
  for (const c of cookies) md += `| ${c.name} | ${c.session ? 'да' : 'нет'} | ${c.httpOnly ? 'да' : 'нет'} | ${c.expiresInDays ?? '—'} |\n`;
  md +=
    '\nЧтобы проверить, что вход переживает перезапуск: закройте виджет, запустите снова и повторите спайк. ' +
    'Сессионные cookie виджет закрепляет на 28 дней сам (persistSessionCookies).\n\n';
  const sess = cookies.filter((c) => c.session).length;
  summary.push(`Claude: cookie ${cookies.length}, сессионных ${sess} (виджет закрепляет их на диск)`);
  return md;
}

function codexSection(summary: string[]): string {
  let md = '## ChatGPT Desktop (Codex): локальные логи\n\n';
  const dir = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions');
  if (!existsSync(dir)) {
    summary.push('Codex: каталог rollout-логов не найден');
    return md + `Каталог \`${dir.replace(homedir(), '~')}\` не найден. Нужно найти, где ChatGPT Desktop хранит rollout-логи; вариант — \`codex app-server\`.\n\n`;
  }
  // Ищем самый свежий rollout-файл; читаем только строки с rate_limits, тексты разговоров не трогаем.
  const files: Array<{ p: string; m: number }> = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push({ p, m: statSync(p).mtimeMs });
    }
  };
  walk(dir, 0);
  files.sort((a, b) => b.m - a.m);
  md += `Каталог найден, rollout-файлов: ${files.length}.\n\n`;
  summary.push(`Codex: rollout-файлов ${files.length}`);
  for (const f of files.slice(0, 5)) {
    const lines = readFileSync(f.p, 'utf8').split('\n').filter((l) => l.includes('rate_limits'));
    const r = latestRateLimits(lines);
    if (!r) continue;
    md += 'Образец rate_limits (числа и поля, без текстов):\n\n' + json({ plan: r.plan, limitId: r.limitId, primary: r.primary, secondary: r.secondary });
    // На реальных логах у записей бывает свой limit_id, а окна — null: показываем, какие корзины есть и что в них.
    const byId = new Map<string, { n: number; withWindows: number; last: ReturnType<typeof parseRateLimitsLine> }>();
    for (const l of lines) {
      const p = parseRateLimitsLine(l);
      if (!p) continue;
      const key = p.limitId ?? '(без limit_id)';
      const e = byId.get(key) ?? { n: 0, withWindows: 0, last: null };
      e.n++;
      if (p.primary || p.secondary) {
        e.withWindows++;
        e.last = p;
      }
      byId.set(key, e);
    }
    md += '\nКорзины лимитов в этом файле:\n\n| limit_id | записей | с окнами | последнее значение окон |\n|---|---|---|---|\n';
    for (const [id, e] of byId) {
      const w = e.last
        ? [e.last.primary && `5ч ${e.last.primary.usedPct}% / ${e.last.primary.windowMinutes} мин`, e.last.secondary && `нед ${e.last.secondary.usedPct}% / ${e.last.secondary.windowMinutes} мин`].filter(Boolean).join('; ')
        : '—';
      md += `| ${id} | ${e.n} | ${e.withWindows} | ${w} |\n`;
    }
    md += '\n';
    const raw = lines.at(-1) ? (JSON.parse(lines.at(-1)!) as Record<string, unknown>) : null;
    if (raw) md += 'Форма строки (обезличено):\n\n' + json(redact(raw));
    summary.push(`Codex: rate_limits найдены (${r.primary ? 'primary ' : ''}${r.secondary ? 'secondary' : ''})`);
    return md;
  }
  summary.push('Codex: в свежих rollout-файлах нет rate_limits');
  return md + 'В пяти последних rollout-файлах строк `rate_limits` нет.\n\n';
}

export async function runSpike(d: SpikeDeps): Promise<SpikeResult> {
  const summary: string[] = [];
  let md = '# Шаг 0: образцы по источникам данных\n\n';
  md += `Снято ${new Date().toISOString()} на машине пользователя. Значения cookie, тексты разговоров и идентификаторы не сохраняются.\n\n`;
  try {
    const net = await d.networkReport();
    md += '## Сеть\n\n' + net.lines.map((l) => `- ${l}`).join('\n') + '\n\n';
    summary.push(net.summary);
  } catch (e) {
    summary.push(`Сеть: ${(e as Error).message}`);
    md += `Ошибка проверки сети: ${(e as Error).message}\n\n`;
  }
  try {
    md += await claudeSection(d, summary);
  } catch (e) {
    d.log(`спайк Claude: ${(e as Error).message}`);
    summary.push(`Claude: ошибка ${(e as Error).message}`);
    md += `Ошибка спайка Claude: ${(e as Error).message}\n\n`;
  }
  try {
    md += codexSection(summary);
  } catch (e) {
    summary.push(`Codex: ошибка ${(e as Error).message}`);
    md += `Ошибка спайка Codex: ${(e as Error).message}\n\n`;
  }
  md +=
    '## Не автоматизировано\n\n' +
    '- Модель, режим и время задачи в Claude Desktop (UI Automation, отладочный порт): замеры нагрузки делаются вручную, см. docs/data-sources.md.\n' +
    '- Поведение 5-часового окна (старт с первого сообщения, сброс через 5 часов): отправьте сообщение сразу после сброса и сравните resets_at до и после.\n' +
    '- Запасной путь через сессию Claude Desktop (DPAPI): включается настройкой, на реальном хранилище не проверялся.\n';
  mkdirSync(d.outDir, { recursive: true });
  const file = join(d.outDir, 'data-sources.generated.md');
  writeFileSync(file, md, 'utf8');
  return { file, summary };
}
