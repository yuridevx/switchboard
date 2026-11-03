// Первое заполнение записи проектов при выкладке: каждая папка сессии становится проектом с тем же номером, домашняя — «Без проекта». Удаляется после выкладки на прод.
// Запись уже есть — отказ словом: второй запуск ничего не перетрёт. Состав пуст — запись не создаётся.
// env: FILL_KEY — пропуск клиента флота; SWITCHBOARD_WORKERS — карта адресов флота (без неё — тестовый).
import { FLEET_PREFIX, firstFill, PROJECTS } from "@switchboard/records";
import { client } from "./client.ts";
import { folderOf } from "../web/packages/ui/src/format.ts";

const KEY = `${FLEET_PREFIX}.${PROJECTS}`;
const WAIT_MS = 30_000;

const c = client(process.env.FILL_KEY!);
const stop = (word: string, code: number): never => {
  console.log(word);
  c.close();
  process.exit(code);
};
const t0 = Date.now();
while (c.state !== "open") {
  if (Date.now() - t0 > WAIT_MS) stop(`флот не собран за ${WAIT_MS} мс: ${c.state}`, 1);
  await new Promise((r) => setTimeout(r, 250));
}
const read = (await c.request({ type: "prefs.get", v: 1, scope: "global" } as never)) as { ok: boolean; error?: string; result?: { values: Record<string, unknown> } };
if (!read.ok) stop(`prefs.get: ${read.error}`, 1);
if (read.result!.values[KEY] !== undefined) stop(`${KEY} уже есть: заполнять нечего`, 0);
const sessions = c.roster?.sessions ?? [];
if (!sessions.length) stop("сессий нет: запись не создана", 0);
const record = firstFill(sessions.map((s) => ({ callsign: s.callsign, folder: folderOf(s.dir) })));
const w = (await c.request({ type: "prefs.set", v: 1, scope: "global", name: KEY, value: record } as never)) as { ok: boolean; error?: string };
if (!w.ok) stop(`prefs.set: ${w.error}`, 1);
const placed = record.flatMap((r) => r.sessions).length;
stop(`проектов ${record.length}, сессий в проектах ${placed}, вне проектов ${sessions.length - placed}`, 0);
