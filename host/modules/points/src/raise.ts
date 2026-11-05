// Поднять сессию из точки: перенос, копия, откат и смена папки — один путь: реестр → блоки → файлы → сессия → точка подъёма.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { claudeDir, clientPath, refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Result, Session } from "@switchboard/host";
import { bring, BUNDLE, folderOf, type Folder, type Summary } from "./git.ts";
import { projectDir, r2Failed, r2Fetch, sha256, snap, type PointFile } from "./snap.ts";

type Row = { sid: string; callsign?: string; files: PointFile[]; git?: Summary };
type Got = { owner: string; points: Row[]; links: Record<string, string> };

/** Отказ чужим словом как есть. */
const must = (r: Result) => {
  if (!r.ok) throw refuse(r.error, r.why as string | undefined);
  return r.result;
};

async function block(host: Host, hash: string, url: string): Promise<Buffer> {
  const res = await r2Fetch(url).catch((e) => {
    throw r2Failed(host, `блок ${hash}: ${e}`);
  });
  if (!res.ok) throw r2Failed(host, `блок ${hash}: ${res.status}`);
  const packed = Buffer.from(await res.arrayBuffer());
  try {
    const part = zstdDecompressSync(packed);
    if (sha256(part) === hash) return part;
  } catch {
    // ниже: тот же отказ, что у несовпавшего отпечатка
  }
  throw refuse("bad_point", `блок ${hash} не тот`);
}

/** Все файлы точки в памяти: пишутся только целиком проверенные. */
async function download(host: Host, row: Row, links: Record<string, string>): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of row.files) {
    const parts: Buffer[] = [];
    for (const hash of f.b) parts.push(await block(host, hash, links[hash]));
    out.set(f.p, Buffer.concat(parts));
  }
  return out;
}

/** Прежние копии разговора в других папках проектов уходят в сторону: resume находит файл по sid во всех папках. */
function setAside(sid: string, target: string) {
  const projects = join(claudeDir(), "projects");
  for (const name of existsSync(projects) ? readdirSync(projects) : []) {
    const old = join(projects, name, `${sid}.jsonl`);
    if (join(projects, name) !== target && existsSync(old)) renameSync(old, `${old}.aside-${Date.now()}`);
  }
}

function writeFiles(target: string, files: Map<string, Buffer>) {
  for (const [p, data] of files) {
    if (p === BUNDLE) continue;
    const file = join(target, p);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

const sessionsOf = (host: Host) => host.sessions().flatMap((x) => (host.session(x.callsign) ? [{ ...x, s: host.session(x.callsign)! }] : []));

export type Raised = { callsign: string; point: number | null; folder: Folder["folder"] | "keep"; branch: string | null };

/** Подъём; mark ставит пометку поднятой сессии. Копия кладёт первую точку сама, на первом конце хода. */
export async function raise(req: Frame, { host, from }: Ctx, mark: (s: Session, base?: number) => void): Promise<Raised | Folder> {
  const sid = req.sid as string;
  const point = req.point as number;
  const copy = req.copy === true;
  if (!Number.isInteger(point)) throw refuse("bad_point", "нет номера точки");
  const dir = typeof req.dir === "string" ? clientPath(req.dir) : null;
  if (!dir) throw refuse("bad_dir", `папка ${req.dir}: только полный путь или от ~`);
  const got = must(await host.request("points.get", { to: ".points", ids: [point] })) as Got;
  const row = got.points[0];
  if (row.sid !== sid) throw refuse("bad_point", `точка ${point} — другой сессии`);

  const here = sessionsOf(host);
  const previous = here.find((x) => x.s.info.session_id === sid);
  const near = here.filter((x) => resolve(x.cwd) === resolve(dir) && x.state !== "stopped" && x !== previous).map((x) => x.callsign);
  const check = await folderOf(dir, row.git, near);
  if (req.dryRun === true) return check;
  if (previous && !copy && previous.state !== "stopped" && previous.state !== "failed") throw refuse("running", `${previous.callsign} идёт`);
  const keep = req.files !== "point";
  if (!keep && check.folder === "other") throw refuse("bad_dir", `в ${dir} другой репозиторий`);

  const files = await download(host, row, got.links);
  const target = projectDir(dir);
  if (!copy) setAside(sid, target);
  writeFiles(target, files);
  const bringing = !keep && row.git && ["empty", "same", "shared"].includes(check.folder);
  const branch = bringing ? await bring(dir, row.git!, check.folder, files.get(BUNDLE)) : null;

  const name = (row.callsign ?? sid).split("@")[0];
  const moved = !copy && got.owner !== host.machine;
  const before = `${name}@${got.owner}`;
  const callsign = previous && !copy ? await restart(host, previous.callsign, point) : await open(host, req, { from, dir, sid, point, copy, name, moved, before });
  if (copy) {
    rmSync(join(target, `${sid}.jsonl`), { force: true });
    rmSync(join(target, sid), { recursive: true, force: true });
  }

  const s = host.session(callsign)!;
  host.log({ kind: "note", ev: "raise", callsign, sid, point, copy, why: `${callsign}: поднята из точки ${point}` });
  mark(s, copy ? point : undefined);
  const folder = keep ? "keep" : check.folder;
  if (copy) return { callsign, point: null, folder, branch };

  const put = await snap(host, s, "raise", { base: point, expect: got.owner, ...(from ? { by: from } : {}) }).catch(async (e) => {
    if (e.word === "not_owner") must(await host.request("session.remove", { callsign }));
    throw e;
  });
  if (moved) {
    const r = await host.request("session.remove", { callsign: before });
    if (!r.ok) host.log({ kind: "refuse", ev: "session.remove", word: r.error, callsign: before, why: `${before}: прежняя не убрана` });
  }
  return { callsign, point: put.id, folder, branch };
}

async function restart(host: Host, callsign: string, point: number): Promise<string> {
  must(await host.request("session.start", { callsign, point }));
  return callsign;
}

type Opening = { from?: string; dir: string; sid: string; point: number; copy: boolean; name: string; moved: boolean; before: string };

/** Новая сессия через manage; не открылась при переносе — прежняя снова идёт на своей машине. */
async function open(host: Host, req: Frame, o: Opening): Promise<string> {
  const pick = Object.fromEntries((["slot", "profile"] as const).flatMap((k) => (typeof req[k] === "string" ? [[k, req[k]]] : [])));
  const name = typeof req.name === "string" ? req.name : o.copy ? basename(o.dir) : o.name;
  const r = await host.request("session.open", { machine: host.machine, name, dir: o.dir, mkdir: true, resume: o.sid, point: o.point, ...(o.copy ? { fork: true } : {}), ...pick, ...(o.from ? { from: o.from } : {}) });
  if (!r.ok && o.moved) await host.request("session.start", { callsign: o.before });
  return (must(r) as { callsign: string }).callsign;
}
