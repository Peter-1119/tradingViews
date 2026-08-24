/**
 * Generates the app / tray icons as PNGs with no image dependencies.
 *
 * A tiny software rasteriser (4x supersampled, so edges are smooth) draws a
 * candlestick glyph, and a minimal PNG encoder writes it out. electron-builder
 * derives the Windows .ico from build/icon.png automatically.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

/* --------------------------------------------------------- PNG encoding */

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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ rasteriser */

function createCanvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function blend(canvas, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h || a <= 0) return;
  const i = (y * canvas.w + x) * 4;
  const src = a / 255;
  const dstA = canvas.data[i + 3] / 255;
  const outA = src + dstA * (1 - src);
  if (outA === 0) return;
  for (let c = 0; c < 3; c++) {
    const sc = [r, g, b][c];
    canvas.data[i + c] = Math.round((sc * src + canvas.data[i + c] * dstA * (1 - src)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

function fillRect(canvas, x, y, w, h, color) {
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      blend(canvas, px, py, color);
    }
  }
}

function fillRoundRect(canvas, x, y, w, h, radius, color) {
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      const dx = Math.max(x + radius - px - 0.5, px + 0.5 - (x + w - radius), 0);
      const dy = Math.max(y + radius - py - 0.5, py + 0.5 - (y + h - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) blend(canvas, px, py, color);
    }
  }
}

/** Box-downsample by `factor` for cheap anti-aliasing. */
function downsample(canvas, factor) {
  const w = canvas.w / factor;
  const h = canvas.h / factor;
  const out = createCanvas(w, h);
  const samples = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = ((y * factor + sy) * canvas.w + (x * factor + sx)) * 4;
          const sa = canvas.data[i + 3];
          r += canvas.data[i] * sa;
          g += canvas.data[i + 1] * sa;
          b += canvas.data[i + 2] * sa;
          a += sa;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round(a / samples);
    }
  }
  return out;
}

/* ------------------------------------------------------------- the glyph */

const BG = [17, 21, 30, 255];
const UP = [38, 194, 129, 255];
const DOWN = [237, 84, 101, 255];

/**
 * @param size    final pixel size
 * @param opaque  true for the app icon (rounded dark plate), false for the
 *                tray icon (glyph only, so it sits on any taskbar colour)
 */
function drawIcon(size, opaque) {
  const SS = 4;
  const canvas = createCanvas(size * SS, size * SS);
  const S = size * SS;

  if (opaque) {
    fillRoundRect(canvas, 0, 0, S, S, S * 0.22, BG);
  }

  // Three candles: down, up, up - reads as a chart even at 16px.
  const candles = [
    { x: 0.18, bodyTop: 0.30, bodyBottom: 0.58, wickTop: 0.20, wickBottom: 0.70, color: DOWN },
    { x: 0.44, bodyTop: 0.42, bodyBottom: 0.74, wickTop: 0.32, wickBottom: 0.84, color: UP },
    { x: 0.70, bodyTop: 0.18, bodyBottom: 0.50, wickTop: 0.12, wickBottom: 0.60, color: UP },
  ];

  const bodyW = 0.13 * S;
  const wickW = Math.max(0.035 * S, SS);

  for (const c of candles) {
    const cx = c.x * S;
    fillRect(canvas, cx + bodyW / 2 - wickW / 2, c.wickTop * S, wickW, (c.wickBottom - c.wickTop) * S, c.color);
    fillRoundRect(
      canvas,
      cx,
      c.bodyTop * S,
      bodyW,
      (c.bodyBottom - c.bodyTop) * S,
      Math.min(bodyW * 0.25, 0.02 * S),
      c.color
    );
  }

  return downsample(canvas, SS);
}

function write(name, size, opaque) {
  const canvas = drawIcon(size, opaque);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(canvas.w, canvas.h, canvas.data));
  console.log('[gen-icon]', name, size + 'x' + size);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
write('icon.png', 512, true); // electron-builder converts this to icon.ico
write('tray.png', 32, false);
write('tray@2x.png', 64, false);
