import { deflateSync } from 'node:zlib';

// Иконка рисуется программно (круг-циферблат с долей), чтобы не хранить бинарные файлы в репозитории.

function crc32(buf: Buffer): number {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA-растр → PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 бит на канал
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface IconColors {
  ring: [number, number, number];
  fill: [number, number, number];
  bg: [number, number, number];
}

/** Круг с дугой заполнения: `fraction` — доля 0..1, цвет дуги зависит от статуса. */
export function renderGauge(size: number, fraction: number, arc: [number, number, number]): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size / 2 - 0.5;
  const inner = outer * 0.62;
  const f = Math.max(0, Math.min(1, fraction));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      // Антиалиасинг по краю круга.
      const edge = Math.max(0, Math.min(1, outer + 0.5 - r));
      if (edge <= 0) continue;
      let col: [number, number, number] = [42, 46, 56];
      if (r >= inner) {
        // угол от «12 часов» по часовой стрелке
        let a = Math.atan2(dx, -dy);
        if (a < 0) a += Math.PI * 2;
        col = a / (Math.PI * 2) <= f ? arc : [88, 94, 108];
      }
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = Math.round(255 * edge);
    }
  }
  return px;
}

export function gaugePng(size: number, fraction: number, arc: [number, number, number]): Buffer {
  return encodePng(size, size, renderGauge(size, fraction, arc));
}
