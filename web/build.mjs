// Статика оболочки веб-приложения (телефон, пульт): esbuild → <приложение>/dist/ (app.js, sw.js, статика, значки) —
// содержимое архива оболочки в каталоге. Модулей, адресов relay и Worker'ов, пропусков и секретов в ней нет:
// модули и адреса страница берёт из build.json сборки «Выпусков».
// app.js — классический скрипт оболочки (ставит import map до первого модуля); sw.js — обработчик пушей пакета
// web-alerts, один на оба приложения.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const web = dirname(fileURLToPath(import.meta.url));

/** Собрать приложение из папки app (src/main.ts, public/) под именем name. */
export async function buildApp(app, name) {
  const here = app;
  const out = join(here, "dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    minify: true,
    target: "es2022",
    logLevel: "warning",
  };
  // оболочка — классический скрипт: import map сборки должен встать раньше первого модуля
  await build({
    ...common,
    entryPoints: [join(here, "src/main.ts")],
    outfile: join(out, "app.js"),
    format: "iife",
  });
  // обработчик пушей — классический скрипт: регистрируется без type: "module"
  await build({
    ...common,
    entryPoints: [join(web, "packages/alerts/worker.ts")],
    outfile: join(out, "sw.js"),
    format: "iife",
  });
  cpSync(join(here, "public"), out, { recursive: true });

  // значки: буква S на синем — PNG без внешних пакетов
  for (const [name, size] of [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["apple-touch-icon.png", 180],
  ]) {
    writeFileSync(join(out, name), icon(size));
  }
  console.log(`${name}: dist/ собран — оболочка без модулей и адресов`);
}

function icon(size) {
  // S — 5×7 точек, по центру, на поле цвета accent
  const S = ["01111", "10000", "10000", "01110", "00001", "00001", "11110"];
  const cell = Math.floor(size / 11);
  const ox = Math.floor((size - 5 * cell) / 2);
  const oy = Math.floor((size - 7 * cell) / 2);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - ox) / cell);
      const cy = Math.floor((y - oy) / cell);
      const on = x >= ox && y >= oy && cx < 5 && cy < 7 && S[cy][cx] === "1";
      const [r, g, b] = on ? [255, 255, 255] : [0x27, 0x47, 0xc9];
      const i = y * (size * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // глубина
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
