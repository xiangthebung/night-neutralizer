/**
 * Deterministic icon generation.
 *
 * The extension ships no binary assets in source control: the PNG icons are
 * synthesised at build time with a tiny hand-rolled PNG encoder (zlib comes
 * from Node's standard library). This keeps the repository text-only and
 * auditable, which matters for an extension that asks users to trust it.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode raw RGBA pixels (row-major, 4 bytes per pixel) as a PNG buffer. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.slice(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * Icon art: a soft rounded square in near-black navy with a warm crescent moon
 * and a compressed waveform underneath. 4x4 supersampled for clean edges.
 */
function sampleIcon(u, v) {
  // Rounded-square mask in normalised [0,1] space.
  const r = 0.24;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const corner = Math.hypot(dx, dy);
  const inside = 1 - smoothstep(r - 0.02, r, corner);
  if (inside <= 0) return [0, 0, 0, 0];

  // Vertical background gradient.
  const g = v;
  let cr = 0.055 + 0.02 * (1 - g);
  let cg = 0.075 + 0.025 * (1 - g);
  let cb = 0.12 + 0.04 * (1 - g);

  // Warm crescent: big disc minus an offset disc.
  const moon = Math.hypot(u - 0.44, v - 0.4);
  const bite = Math.hypot(u - 0.6, v - 0.3);
  const moonMask = (1 - smoothstep(0.245, 0.265, moon)) * smoothstep(0.225, 0.245, bite);
  if (moonMask > 0) {
    const warmth = 0.9 + 0.1 * (1 - v);
    cr = cr * (1 - moonMask) + 0.98 * warmth * moonMask;
    cg = cg * (1 - moonMask) + 0.86 * warmth * moonMask;
    cb = cb * (1 - moonMask) + 0.62 * moonMask;
  }

  // Halo around the moon so the icon reads at 16px.
  const halo = (1 - smoothstep(0.26, 0.42, moon)) * 0.16;
  cr += halo * 0.5;
  cg += halo * 0.42;
  cb += halo * 0.3;

  // Compressed waveform: three bars of near-equal height (the whole point of
  // the extension is that loud and quiet end up closer together).
  const bars = [
    [0.3, 0.1],
    [0.5, 0.13],
    [0.7, 0.105],
  ];
  for (const [bx, bh] of bars) {
    const inBarX = 1 - smoothstep(0.045, 0.06, Math.abs(u - bx));
    const inBarY = 1 - smoothstep(bh - 0.01, bh, Math.abs(v - 0.79));
    const m = inBarX * inBarY * 0.95;
    if (m > 0) {
      cr = cr * (1 - m) + 0.36 * m;
      cg = cg * (1 - m) + 0.6 * m;
      cb = cb * (1 - m) + 0.86 * m;
    }
  }

  return [clamp01(cr), clamp01(cg), clamp01(cb), inside];
}

export function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          const [pr, pg, pb, pa] = sampleIcon(u, v);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const n = samples * samples;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      // Un-premultiply so PNG stores straight alpha.
      const inv = a > 0 ? 1 / a : 0;
      rgba[i] = Math.round(clamp01(r * inv) * 255);
      rgba[i + 1] = Math.round(clamp01(g * inv) * 255);
      rgba[i + 2] = Math.round(clamp01(b * inv) * 255);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

export const ICON_SIZES = [16, 32, 48, 128];
