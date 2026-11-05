// Значок приложения: белая S на синем поле, PNG без внешних пакетов.
import { crc32, deflateSync } from "node:zlib";

const LETTER = ["01111", "10000", "10000", "01110", "00001", "00001", "11110"];
const WHITE = [255, 255, 255];
const ACCENT = [0x27, 0x47, 0xc9];
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
  return out;
}

/** PNG size×size: RGB без прозрачности, буква по центру. */
export function icon(size) {
  const cell = Math.floor(size / 11);
  const left = Math.floor((size - 5 * cell) / 2);
  const top = Math.floor((size - 7 * cell) / 2);
  const inLetter = (x, y) => LETTER[Math.floor((y - top) / cell)]?.[Math.floor((x - left) / cell)] === "1" && x >= left && y >= top;
  const row = size * 3 + 1;
  const pixels = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) pixels.set(inLetter(x, y) ? WHITE : ACCENT, y * row + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2], 8); // 8 бит на канал, RGB
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
