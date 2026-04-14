#!/usr/bin/env node
// Generates placeholder PWA icons at the sizes required by manifest.webmanifest.
// Writes solid-color PNGs with a centered "R2" glyph drawn as simple rectangles.
// Intentionally dependency-free: uses Node's zlib + a tiny PNG encoder inline.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'packages', 'client', 'public');
mkdirSync(outDir, { recursive: true });

const BG = [0x0f, 0x17, 0x2a, 0xff]; // #0f172a
const FG = [0xff, 0xff, 0xff, 0xff];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(width, height, pixels) {
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = y * (1 + width * 4) + 1 + x * 4;
      const p = pixels[y * width + x];
      raw[i] = p[0]; raw[i + 1] = p[1]; raw[i + 2] = p[2]; raw[i + 3] = p[3];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size, { maskable = false } = {}) {
  const pixels = new Array(size * size);
  for (let i = 0; i < pixels.length; i++) pixels[i] = BG;

  const inset = maskable ? Math.floor(size * 0.1) : 0;
  const inner = size - inset * 2;

  const barW = Math.floor(inner * 0.2);
  const barH = Math.floor(inner * 0.6);
  const gap = Math.floor(inner * 0.08);
  const totalW = barW * 2 + gap;
  const startX = inset + Math.floor((inner - totalW) / 2);
  const startY = inset + Math.floor((inner - barH) / 2);

  function fill(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && x < size && y >= 0 && y < size) pixels[y * size + x] = FG;
      }
    }
  }
  fill(startX, startY, barW, barH);
  fill(startX + barW + gap, startY + Math.floor(barH * 0.15), barW, Math.floor(barH * 0.85));

  return encodePng(size, size, pixels);
}

writeFileSync(resolve(outDir, 'icon-192.png'), drawIcon(192));
writeFileSync(resolve(outDir, 'icon-512.png'), drawIcon(512));
writeFileSync(resolve(outDir, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));

console.log('✓ Wrote icon-192.png, icon-512.png, icon-maskable-512.png');
