// switchboard pull — сессия из архива на свой компьютер, где нет Host: та же раскладка «точка → файлы», что у подъёма на машине флота.
// Пропуск устройства человека и адрес Worker'а points — из окружения: SWITCHBOARD_PASS, SWITCHBOARD_POINTS.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { READ_MS } from "@switchboard/protocol";
import { bring, BUNDLE, folderOf, type Summary } from "./git.ts";
import { download, projectDirOf, setAside, writeFiles, type PointFile } from "./lay.ts";
import { Refused } from "./refused.ts";

export const PULL_USAGE = "вызов: switchboard pull <callsign | sid> [--point N] [--dir путь]";
const NO_ENV = "нет SWITCHBOARD_POINTS или SWITCHBOARD_PASS в окружении: адрес Worker'а points и пропуск своего устройства";
/** Скачивание блоков точки и git — дольше чтения. */
const PULL_MS = 600_000;

type Env = Record<string, string | undefined>;
type Answer = { ok: boolean; result?: any; error?: string; why?: string };
type Row = { id: number; sid: string; callsign?: string; dir?: string; files: PointFile[]; git?: Summary };

function args(argv: string[]) {
  const [who, ...rest] = argv;
  if (!who || who.startsWith("--")) throw new Error(PULL_USAGE);
  const o: { who: string; point?: number; dir?: string } = { who };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--point" && /^\d+$/.test(rest[i + 1] ?? "")) o.point = Number(rest[++i]);
    else if (rest[i] === "--dir" && rest[i + 1]) o.dir = rest[++i];
    else throw new Error(`незнакомый аргумент: ${rest[i]}\n${PULL_USAGE}`);
  }
  return o;
}

const homePath = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(p));

/** Ответ points словом: отказ — ошибка с его словом. */
async function ask(env: Env, type: string, frame: Record<string, unknown>, version: number, ms: number): Promise<any> {
  const body = JSON.stringify({ type, v: version, id: randomUUID(), key: env.SWITCHBOARD_PASS, ...frame });
  const r = (await (await fetch(env.SWITCHBOARD_POINTS!, { method: "POST", body, signal: AbortSignal.timeout(ms) })).json()) as Answer;
  if (!r.ok) throw new Refused(r.error ?? "failed", `${type}: ${r.why ?? r.error}`);
  return r.result;
}

/** Сессия по callsign или sid: из каталога архива; у одного callsign — последняя по времени. */
async function sessionOf(env: Env, who: string): Promise<{ sid: string; head: number }> {
  const { sessions } = (await ask(env, "points.list", { limit: 1000 }, 2, READ_MS)) as { sessions: Array<{ sid: string; callsign?: string; head: { id: number } }> };
  const found = sessions.find((s) => s.sid === who || s.sid.startsWith(who)) ?? sessions.find((s) => s.callsign === who);
  if (!found) throw new Refused("no_point", `${who}: такой сессии в архиве нет`);
  return { sid: found.sid, head: found.head.id };
}

/** Pull: точка → файлы разговора в папке проекта Claude, git — в папке; печатает команду продолжения. Код выхода. */
export async function pull(argv: string[], env: Env, out: (line: string) => void = console.log): Promise<number> {
  const o = args(argv);
  if (!env.SWITCHBOARD_POINTS || !env.SWITCHBOARD_PASS) throw new Error(NO_ENV);
  const { sid, head } = await sessionOf(env, o.who);
  const got = (await ask(env, "points.get", { ids: [o.point ?? head] }, 2, READ_MS)) as { points: Row[]; links?: Record<string, string> };
  const row = got.points[0];
  if (row.sid !== sid) throw new Refused("bad_point", `точка ${o.point} — другой сессии`);
  if (!got.links) throw new Refused("no_links", "points не отдал ссылки на блоки этому пропуску");
  const dir = homePath(o.dir ?? basename(row.dir ?? row.callsign?.split("@")[0] ?? sid));
  const check = await folderOf(dir, row.git, []);
  if (check.folder === "other") throw new Refused("bad_dir", `${dir}: другой репозиторий`);
  const files = await Promise.race([download(row.files, got.links), new Promise<never>((_, fail) => setTimeout(() => fail(new Refused("timeout", "блоки не скачались за 10 мин")), PULL_MS).unref())]);
  const branch = row.git && (check.folder === "empty" || check.folder === "same") ? await bring(dir, row.git, check.folder, files.get(BUNDLE)) : null;
  const claude = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const target = projectDirOf(claude, dir);
  setAside(claude, sid, target);
  writeFiles(target, files, sid, sid);
  out(`точка ${row.id}: разговор → ${join(target, `${sid}.jsonl`)}${branch ? `, ветка ${branch} в ${dir}` : ""}`);
  out(`cd ${JSON.stringify(dir)} && claude --resume ${sid}`);
  return 0;
}
