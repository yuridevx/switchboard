// Поднять сессию из точки: перенос, копия, откат и смена папки — один путь: проверка → блоки → папка и файлы → сессия → точка подъёма.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { claudeDir, clientPath, refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Result, Session } from "@switchboard/host";
import { bring, BUNDLE, folderOf, type Folder, type Summary } from "./git.ts";
import { projectDir, r2Fetch, sha256, type PointExtra, type PointFile, type Why } from "./snap.ts";

const unpack = promisify(zstdDecompress);

type Row = { sid: string; callsign?: string; files: PointFile[]; git?: Summary };
type Check = Omit<Folder, "folder"> & { folder: Folder["folder"] | "keep" };

/** Что подъёму даёт модуль: пометка поднятой сессии, точка по очереди сессии, сессия без точки на закрытии. */
type Rule = { mark(s: Session, base?: number): void; save(s: Session, why: Why, extra?: PointExtra): Promise<{ id: number }>; drop(callsign: string): void };

/** Что поднимаем и куда: всё проверено, на машине ещё ничего не тронуто. */
type Plan = { sid: string; point: number; copy: boolean; dir: string; row: Row; owner: string; links: Record<string, string>; previous?: Session; check: Check };

/** Отказ чужим словом как есть. */
const must = (r: Result) => {
  if (!r.ok) throw refuse(r.error, r.why as string | undefined);
  return r.result;
};

const hereOf = (host: Host) => host.sessions().flatMap((x) => host.session(x.callsign) ?? []);

async function plan(host: Host, req: Frame): Promise<Plan> {
  const { sid, point } = req as unknown as { sid: string; point: number };
  const copy = req.copy === true;
  if (!Number.isInteger(point)) throw refuse("bad_point", "points.raise без номера точки");
  const dir = typeof req.dir === "string" ? clientPath(req.dir) : null;
  if (!dir) throw refuse("bad_dir", `папка ${req.dir}: нужен путь от ~ или полный`);
  const got = must(await host.request("points.get", { to: ".points", ids: [point] })) as { owner: string; points: Row[]; links: Record<string, string> };
  const row = got.points[0];
  if (row.sid !== sid) throw refuse("bad_point", `точка ${point} — другой сессии`);
  const previous = hereOf(host).find((s) => s.info.session_id === sid);
  if (!copy && previous && previous.state !== "stopped" && previous.state !== "failed") throw refuse("running", `${previous.info.callsign} ещё идёт`);
  const near = host.sessions().filter((x) => resolve(x.cwd) === resolve(dir) && x.state !== "stopped" && x.callsign !== previous?.info.callsign).map((x) => x.callsign);
  const check = req.files === "keep" ? { folder: "keep" as const, files: 0, branch: null, sessions: [] } : await folderOf(dir, row.git, near);
  return { sid, point, copy, dir, row, owner: got.owner, links: got.links, previous, check };
}

async function block(hash: string, url: string, host: Host): Promise<Buffer> {
  const res = await r2Fetch(host, url);
  const packed = Buffer.from(await res.arrayBuffer());
  const part = await unpack(packed).catch(() => {
    throw refuse("bad_point", `блок ${hash} не открылся`);
  });
  if (sha256(part) !== hash) throw refuse("bad_point", `блок ${hash} не тот`);
  return part;
}

/** Все файлы точки в памяти: файлы на машине трогаются, только когда все блоки на руках. */
async function download(host: Host, p: Plan): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of p.row.files) {
    const parts: Buffer[] = [];
    for (const hash of f.b) parts.push(await block(hash, p.links[hash], host));
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

/** Файлы точки в папку проекта: путь из реестра не выходит из неё, файл появляется целиком. */
function writeFiles(target: string, files: Map<string, Buffer>, sid: string, source: string) {
  const paths = [...files.keys()].filter((p) => p !== BUNDLE).map((p) => [p, resolve(target, p.startsWith(sid) ? source + p.slice(sid.length) : p)]);
  for (const [p, file] of paths) if (!file.startsWith(resolve(target) + sep)) throw refuse("bad_point", `путь файла точки вне папки проекта: ${p}`);
  for (const [p, file] of paths) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, files.get(p)!);
    renameSync(`${file}.tmp`, file);
  }
}

/**
 * Папка и файлы точки. source — имя файла, с которого open начнёт разговор: копия в папку этой же сессии ложится под своим именем,
 * файл сессии остаётся её файлом (опыт на настоящем claude: resume с forkSession берёт файл под другим именем, разговор — разговор точки).
 */
async function lay(host: Host, p: Plan): Promise<{ branch: string | null; source: string }> {
  const files = await download(host, p);
  const target = projectDir(p.dir);
  const own = p.copy && p.previous !== undefined && resolve(p.previous.info.cwd) === resolve(p.dir);
  const source = own ? randomUUID() : p.sid;
  const branch = p.row.git && (p.check.folder === "empty" || p.check.folder === "same") ? await bring(p.dir, p.row.git, p.check.folder, files.get(BUNDLE)) : null;
  if (!p.copy) setAside(p.sid, target);
  writeFiles(target, files, p.sid, source);
  return { branch, source };
}

/** Сессия на этой машине: откат — запуск той же; иначе новая; сорвалось при переносе — прежняя снова идёт на своей машине. */
async function launch(host: Host, req: Frame, p: Plan, source: string): Promise<string> {
  if (p.previous && !p.copy) {
    must(await host.request("session.start", { callsign: p.previous.info.callsign, point: p.point }));
    return p.previous.info.callsign;
  }
  const pick = { ...(typeof req.slot === "string" ? { slot: req.slot } : {}), ...(req.profile !== undefined ? { profile: req.profile } : {}) };
  const name = typeof req.name === "string" ? req.name : basename(p.dir);
  const r = await host.request("session.open", { machine: host.machine, name, dir: req.dir, mkdir: true, resume: source, point: p.point, ...(p.copy ? { fork: true } : {}), ...pick });
  if (!r.ok && !p.copy && p.owner !== host.machine && p.row.callsign) await host.request("session.start", { callsign: p.row.callsign });
  return (must(r) as { callsign: string }).callsign;
}

/** Файл разговора нужен был только open: разговор копии claude пишет сам. */
function dropSource(p: Plan, source: string) {
  const target = projectDir(p.dir);
  rmSync(join(target, `${source}.jsonl`), { force: true });
  rmSync(join(target, source), { recursive: true, force: true });
}

/** Прежняя машина отпускает сессию; не на связи — вернётся и отдаст дописанное сама. */
async function release(host: Host, p: Plan) {
  const { callsign } = p.row;
  if (p.owner === host.machine || !callsign) return;
  const r = await host.request("session.remove", { callsign });
  if (!r.ok) host.log({ kind: "refuse", ev: "session.remove", word: r.error, callsign, why: `прежний хозяин не отпустил ${callsign}` });
}

/** Подъём. Копия кладёт первую точку сама, на первом конце хода. */
export async function raise(req: Frame, { host, from }: Ctx, rule: Rule): Promise<unknown> {
  const p = await plan(host, req);
  if (req.dryRun === true) return p.check;
  if (p.check.folder === "other") throw refuse("bad_dir", `${p.dir}: другой репозиторий`);
  const { branch, source } = await lay(host, p);
  const callsign = await launch(host, req, p, source).finally(() => {
    if (p.copy) dropSource(p, source);
  });
  const s = host.session(callsign)!;
  host.log({ kind: "note", ev: "raise", callsign, sid: p.sid, point: p.point, copy: p.copy, why: `${callsign}: поднята из точки ${p.point}` });
  const raised = { callsign, folder: p.check.folder, branch };
  rule.mark(s, p.copy ? p.point : undefined);
  if (p.copy) return { ...raised, point: null };
  const put = await rule.save(s, "raise", { base: p.point, expect: p.owner, ...(from ? { by: from } : {}) }).catch(async (e) => {
    // точки нет — поднятая здесь лишняя: реестр её не знает
    rule.drop(callsign);
    await host.request("session.remove", { callsign });
    throw e;
  });
  await release(host, p);
  return { ...raised, point: put.id };
}
