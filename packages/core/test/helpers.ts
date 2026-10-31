import { defaultPeakProfile, defaultSchedule, parseHm, zonedToMs, type BudgetSettings } from '../src/index.js';

/** Момент «дата + время» по UTC+3, как в расписании. */
export const msk = (date: string, hm: string): number => zonedToMs(date, parseHm(hm), 'UTC+3');

export function settings(over: Partial<BudgetSettings> = {}): BudgetSettings {
  return {
    reserve: 0.1,
    deviationPct: 5,
    lowAvailablePct: 5,
    schedule: defaultSchedule(),
    peak: defaultPeakProfile(),
    manualK: 0.15,
    ...over,
  };
}
