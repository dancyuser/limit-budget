// Командная строка: статус в JSON, статистика, экспорт в CSV для скриптов, реплей истории, демо-данные.
// Работает с той же базой, что и виджет, и не требует Electron.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DAY,
  FakeProvider,
  MINUTE,
  UsageSimulator,
  defaultPeakProfile,
  defaultSchedule,
  parseHm,
  replay,
  toZoned,
  zonedToMs,
  type PeriodKind,
  type PeriodMode,
  type ProviderId,
  type Snapshot,
} from '@limit-budget/core';
import { Store } from '../shared/db.js';
import { blocksCsv, daysCsv, modelsCsv, snapshotsCsv } from '../shared/export.js';
import { UsageService } from '../shared/service.js';
import { budgetSettings } from '../shared/settings.js';

const USAGE = `limit-budget — бюджетирование лимитов Claude / Codex

Команды:
  status   [--json]                              текущее состояние: факт, цель, «доступно сейчас»
  stats    [--period day|week|2weeks|month] [--mode rolling|calendar] [--json]
  export   --what snapshots|days|models|blocks [--format csv|json] [--out файл]
           [--period …] [--mode …]
  replay   [--from ГГГГ-ММ-ДД] [--to ГГГГ-ММ-ДД] [--json]   прогнать сохранённую историю через калькулятор
  gaps     [--days 7] [--max-gap 5]              пропуски в снимках за период (критерий «7 дней без пропусков»)
  seed-demo [--days 30] [--seed 1]                наполнить базу правдоподобной историей (для проверки)

Общие параметры:
  --db путь        файл базы (по умолчанию %APPDATA%\\LimitBudget\\usage.sqlite или LIMIT_BUDGET_DB)
  --provider claude|chatgpt   (по умолчанию claude)
`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

export function defaultDbPath(): string {
  if (process.env.LIMIT_BUDGET_DB) return process.env.LIMIT_BUDGET_DB;
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.config');
  return join(base, 'LimitBudget', 'usage.sqlite');
}

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

function offlineService(store: Store, providers: ProviderId[]): UsageService {
  const service = new UsageService({
    store,
    providers: providers.map((id) => new FakeProvider(() => [], { id })),
  });
  service.warmUp();
  return service;
}

const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `${v.toFixed(d)}%`);

export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s + '\n')): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.help) {
    out(USAGE);
    return cmd ? 0 : 1;
  }
  const dbPath = str(args.db, defaultDbPath());
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(dbPath);
  try {
    const provider = str(args.provider, 'claude') as ProviderId;
    const kind = str(args.period, 'week') as PeriodKind;
    const mode = str(args.mode, 'rolling') as PeriodMode;
    const json = args.json === true || args.format === 'json';

    if (cmd === 'status') {
      const service = offlineService(store, ['claude', 'chatgpt']);
      const view = service.getViewState();
      if (json) out(JSON.stringify(view, null, 2));
      else {
        for (const p of view.providers) {
          if (!p.enabled || !p.budget || !p.tick) {
            out(`${p.label}: ${p.status}`);
            continue;
          }
          const b = p.budget;
          out(
            `${p.label}: 5ч ${pct(p.tick.u5h)} · доступно ${pct(b.available)} · нед ${pct(p.tick.u7d, 1)} / цель ${pct(b.target, 1)}` +
              `${b.mode === 'vacation' ? ' · ОТПУСК' : ''}${p.status === 'stale' ? ' · устарело' : ''}`,
          );
        }
      }
      return 0;
    }

    if (cmd === 'stats') {
      const service = offlineService(store, [provider]);
      const s = service.getStats(provider, kind, mode);
      if (json) out(JSON.stringify(s, null, 2));
      else {
        out(`Период: ${kind} (${mode}), ${toZoned(s.from, 'UTC+3').dateKey} — ${toZoned(s.to, 'UTC+3').dateKey}`);
        out(`Прирост: 5ч ${s.totals.gain5h.toFixed(1)} п.п., неделя ${s.totals.gain7d.toFixed(1)} п.п.; окон ${s.totals.windows}; работа ${(s.totals.workMinutes / 60).toFixed(1)} ч`);
        for (const m of s.models) {
          out(`  ${m.model}${m.effort ? ' / ' + m.effort : ''}${m.estimated ? ' (оценка)' : ''}: ${m.growthMinutes.toFixed(0)} мин, ${m.d5h.toFixed(1)} / ${m.d7d.toFixed(1)} п.п.`);
        }
      }
      return 0;
    }

    if (cmd === 'export') {
      const what = str(args.what, 'snapshots');
      const service = offlineService(store, [provider]);
      const now = Date.now();
      let text: string;
      if (what === 'snapshots') {
        const ticks = store.getTicks(provider, now - 62 * DAY, now);
        text = json ? JSON.stringify(ticks, null, 2) : snapshotsCsv(ticks);
      } else {
        const stats = service.getStats(provider, kind, mode);
        if (json) text = JSON.stringify(what === 'days' ? stats.days : what === 'models' ? stats.models : stats.blocks, null, 2);
        else text = what === 'days' ? daysCsv(stats) : what === 'models' ? modelsCsv(stats) : blocksCsv(stats);
      }
      if (typeof args.out === 'string') {
        writeFileSync(args.out, '﻿' + text, 'utf8');
        out(`Записано: ${args.out}`);
      } else out(text);
      return 0;
    }

    if (cmd === 'replay') {
      const service = offlineService(store, [provider]);
      const tz = service.schedule.tz;
      const from = typeof args.from === 'string' ? zonedToMs(args.from, 0, tz) : 0;
      const to = typeof args.to === 'string' ? zonedToMs(args.to, 24 * 60, tz) : Date.now();
      const ticks = store.getTicks(provider, from, to);
      const points = replay(ticks, { settings: budgetSettings(service.settings, service.schedule), mode: (ts) => (store.vacationRanges().some((v) => ts >= v.from && (v.to === null || ts < v.to)) ? 'vacation' : 'work') });
      if (json) out(JSON.stringify(points.map((p) => ({ ts: p.ts, tick: p.tick, state: p.state })), null, 2));
      else {
        // Таблица раз в 30 минут, чтобы вывод был обозримым.
        let last = -Infinity;
        for (const p of points) {
          if (p.ts - last < 30 * MINUTE) continue;
          last = p.ts;
          out(
            `${new Date(p.ts).toISOString()}  5ч ${pct(p.tick.u5h)}  нед ${pct(p.tick.u7d, 1)}  цель ${pct(p.state.target, 1)}  доступно ${pct(p.state.available)}  ${p.state.status}${p.state.peakNow ? '  пик' : ''}`,
          );
        }
      }
      return 0;
    }

    if (cmd === 'gaps') {
      const days = Number(str(args.days, '7'));
      const maxGapMin = Number(str(args['max-gap'], '5'));
      const now = Date.now();
      const ticks = store.getTicks(provider, now - days * DAY, now);
      const gaps: Array<{ from: number; to: number; minutes: number }> = [];
      for (let i = 1; i < ticks.length; i++) {
        const gap = (ticks[i].ts - ticks[i - 1].ts) / MINUTE;
        if (gap > maxGapMin) gaps.push({ from: ticks[i - 1].ts, to: ticks[i].ts, minutes: Math.round(gap) });
      }
      const lead = ticks.length ? (ticks[0].ts - (now - days * DAY)) / MINUTE : days * 1440;
      const tail = ticks.length ? (now - ticks[ticks.length - 1].ts) / MINUTE : days * 1440;
      if (json) out(JSON.stringify({ days, maxGapMin, snapshots: ticks.length, gaps, leadMinutes: Math.round(lead), tailMinutes: Math.round(tail) }, null, 2));
      else {
        out(`Снимков за ${days} дн.: ${ticks.length}; пропусков длиннее ${maxGapMin} мин: ${gaps.length}`);
        for (const g of gaps.slice(0, 30)) out(`  ${new Date(g.from).toISOString()} → ${new Date(g.to).toISOString()}  (${g.minutes} мин)`);
        if (lead > maxGapMin) out(`  история начинается через ${Math.round(lead)} мин после начала периода`);
        if (tail > maxGapMin) out(`  последний снимок был ${Math.round(tail)} мин назад`);
      }
      return gaps.length === 0 && lead <= maxGapMin && tail <= maxGapMin ? 0 : 3;
    }

    if (cmd === 'seed-demo') {
      const days = Number(str(args.days, '30'));
      const seed = Number(str(args.seed, '1'));
      const now = Date.now();
      const tz = 'UTC+3';
      const startDay = toZoned(now - days * DAY, tz).dateKey;
      const start = zonedToMs(startDay, 0, tz);
      // Первый недельный сброс — ближайший понедельник 10:00 после начала истории.
      const z = toZoned(start, tz);
      const toMonday = (8 - z.weekday) % 7 || 7;
      const sim = new UsageSimulator({
        start,
        weekResetsAt: zonedToMs(toZoned(start + toMonday * DAY, tz).dateKey, parseHm('10:00'), tz),
        schedule: defaultSchedule(),
        peak: defaultPeakProfile(),
        seed,
      });
      const ticks = sim.advance(now);
      const rows: Snapshot[] = ticks.flatMap((t) => {
        const r: Snapshot[] = [];
        if (t.u5h !== null) r.push({ ts: t.ts, provider: 'claude', window: '5h', bucket: 'all', usedPct: t.u5h, resetsAt: t.r5h, source: 'demo' });
        if (t.u7d !== null) r.push({ ts: t.ts, provider: 'claude', window: '7d', bucket: 'all', usedPct: t.u7d, resetsAt: t.r7d, source: 'demo' });
        return r;
      });
      for (let i = 0; i < rows.length; i += 20000) store.insertSnapshots(rows.slice(i, i + 20000));
      out(`Добавлено ${rows.length} снимков (${days} дн.) в ${dbPath}`);
      return 0;
    }

    out(`Неизвестная команда: ${cmd}\n\n${USAGE}`);
    return 2;
  } finally {
    store.close();
  }
}

// Запуск из командной строки (собранный dist/cli.js).
if (process.argv[1] && /cli\.js$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`Ошибка: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
