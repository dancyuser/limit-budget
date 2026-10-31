// Простые SVG-графики без внешних библиотек.
import { svg } from './dom.js';

export interface Bar {
  label: string;
  value: number;
  /** Ориентир (например, допустимый расход за день): рисуется чёрточкой над столбцом. */
  marker?: number | null;
  /** Столбец за день отпуска рисуется приглушённо. */
  muted?: boolean;
}

export interface BarChartOptions {
  width?: number;
  height?: number;
  color?: string;
  negativeColor?: string;
  unit?: string;
  decimals?: number;
}

export function barChart(bars: Bar[], o: BarChartOptions = {}): SVGSVGElement {
  const width = o.width ?? 760;
  const height = o.height ?? 170;
  const pad = { l: 36, r: 8, t: 10, b: 26 };
  const color = o.color ?? '#5b9cf5';
  const neg = o.negativeColor ?? '#e85050';
  const decimals = o.decimals ?? 1;
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  if (!bars.length) {
    root.append(svg('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }, 'нет данных за период'));
    return root;
  }
  const maxV = Math.max(1e-9, ...bars.map((b) => Math.max(b.value, b.marker ?? 0)));
  const minV = Math.min(0, ...bars.map((b) => b.value));
  const span = maxV - minV;
  const y = (v: number) => pad.t + (1 - (v - minV) / span) * (height - pad.t - pad.b);
  const innerW = width - pad.l - pad.r;
  const bw = innerW / bars.length;
  // ось и подписи
  for (const v of [minV, minV + span / 2, maxV]) {
    root.append(
      svg('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), stroke: '#2a2f3a', 'stroke-width': 1 }),
      svg('text', { x: pad.l - 5, y: y(v) + 3, 'text-anchor': 'end' }, v.toFixed(v === Math.round(v) ? 0 : decimals)),
    );
  }
  if (minV < 0) root.append(svg('line', { x1: pad.l, x2: width - pad.r, y1: y(0), y2: y(0), stroke: '#5b6275', 'stroke-width': 1 }));
  const every = Math.ceil(bars.length / 16);
  bars.forEach((b, i) => {
    const x = pad.l + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const top = y(Math.max(0, b.value));
    const bottom = y(Math.min(0, b.value));
    const rect = svg('rect', {
      x,
      y: top,
      width: w,
      height: Math.max(1, bottom - top),
      rx: 2,
      fill: b.value < 0 ? neg : color,
      opacity: b.muted ? 0.35 : 1,
    });
    rect.append(svg('title', {}, `${b.label}: ${b.value.toFixed(decimals)}${o.unit ?? ''}`));
    root.append(rect);
    if (b.marker !== undefined && b.marker !== null) {
      root.append(svg('line', { x1: x - 2, x2: x + w + 2, y1: y(b.marker), y2: y(b.marker), stroke: '#f0a83c', 'stroke-width': 2 }));
    }
    if (i % every === 0) root.append(svg('text', { x: x + w / 2, y: height - 8, 'text-anchor': 'middle' }, b.label));
  });
  return root;
}

/** Цвет ячейки тепловой карты: от тёмного к янтарному и красному. */
export function heatColor(t: number): string {
  const c = Math.min(1, Math.max(0, t));
  const stops: Array<[number, number, number]> = [
    [38, 70, 110],
    [78, 200, 130],
    [240, 168, 60],
    [232, 80, 80],
  ];
  const pos = c * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const mix = (k: number) => Math.round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}
