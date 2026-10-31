// Звуки сигналов. Встроенные тона синтезируются через WebAudio, поэтому файлов в сборке нет;
// для любого события можно выбрать свой файл. Для предупреждения и превышения лимита звучат разные сигналы.
import type { SignalPayload } from '../shared/ipc.js';

let ctx: AudioContext | null = null;
const audio = () => (ctx ??= new AudioContext());

interface Tone {
  at: number; // секунды от начала
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

const PATTERNS: Record<string, Tone[]> = {
  // предупреждение: два мягких нисходящих тона
  warning: [
    { at: 0, freq: 660, dur: 0.2, type: 'triangle', gain: 0.9 },
    { at: 0.26, freq: 520, dur: 0.28, type: 'triangle', gain: 0.9 },
  ],
  // превышение лимита: три резких чередующихся тона
  exceeded: [
    { at: 0, freq: 880, dur: 0.14, type: 'square', gain: 0.55 },
    { at: 0.18, freq: 440, dur: 0.14, type: 'square', gain: 0.55 },
    { at: 0.36, freq: 880, dur: 0.14, type: 'square', gain: 0.55 },
    { at: 0.54, freq: 440, dur: 0.3, type: 'square', gain: 0.55 },
  ],
  // тихие сигналы
  soft: [{ at: 0, freq: 523, dur: 0.5, type: 'sine', gain: 0.5 }],
  tick: [{ at: 0, freq: 1000, dur: 0.07, type: 'sine', gain: 0.4 }],
  // возможное изменение лимитов: восходящее арпеджио
  change: [
    { at: 0, freq: 440, dur: 0.16, type: 'sine', gain: 0.8 },
    { at: 0.18, freq: 554, dur: 0.16, type: 'sine', gain: 0.8 },
    { at: 0.36, freq: 659, dur: 0.34, type: 'sine', gain: 0.8 },
  ],
};

function playTones(tones: Tone[], volume: number): void {
  const a = audio();
  if (a.state === 'suspended') void a.resume();
  const t0 = a.currentTime + 0.02;
  for (const t of tones) {
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = t.type ?? 'sine';
    osc.frequency.value = t.freq;
    const peak = Math.max(0.0001, volume * (t.gain ?? 1) * 0.5);
    g.gain.setValueAtTime(0.0001, t0 + t.at);
    g.gain.exponentialRampToValueAtTime(peak, t0 + t.at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + t.at + t.dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0 + t.at);
    osc.stop(t0 + t.at + t.dur + 0.03);
  }
}

function fileUrl(path: string): string {
  return 'file:///' + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
}

declare global {
  interface Window {
    __lastSound?: { sound: string; file?: string; at: number; muted: boolean };
  }
}

export function playSignal(p: SignalPayload): void {
  window.__lastSound = { sound: p.sound.sound, file: p.sound.file, at: Date.now(), muted: p.muted };
  if (p.muted || p.sound.sound === 'none') return;
  try {
    if (p.sound.file) {
      const el = new Audio(fileUrl(p.sound.file));
      el.volume = Math.min(1, Math.max(0, p.volume));
      void el.play().catch(() => playTones(PATTERNS.warning, p.volume));
      return;
    }
    playTones(PATTERNS[p.sound.sound] ?? PATTERNS.warning, p.volume);
  } catch (e) {
    console.error('звук не воспроизведён', e);
  }
}
