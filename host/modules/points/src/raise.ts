// Подъём сессии из точки: перенос, откат, копия. Шаги по порядку: блоки → папка → файлы разговора → сессия → точка подъёма → отпустить прежнюю.
// Файлы трогаются только когда все блоки на руках.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Ctx, Frame, Host, Session } from "@switchboard/host";
import { claudeDir, clientPath, refuse } from "@switchboard/host";
import { download, joined, type PointFile } from "./blocks.ts";
import { capture, conversationOf, projectDir, type Took } from "./capture.ts";
import { type GitSummary, place, probe } from "./git.ts";

const PACK = "git.bundle";
const LIVE = new Set(["starting", "idle", "busy", "waiting", "stopping"]);

type Row = { sid: string; callsign?: string; files: PointFile[]; git?: GitSummary };

/** Как модуль кладёт сессию под правило после подъёма и убирает её без точки на закрытии. */
export type Marks = { mark(s: Session, base?: number): void; leave(callsign: string): void; took(s: Session): void };

const here = (host: Host, sid: string) => host.sessions().map((x) => host.session(x.callsign)!).find((s) => s.info.session_id === sid);

/** Старые копии разговора в других папках проектов — в сторону: resume ищет файл по всем папкам. */
function setAside(sid: string, target: string): void {
  const projects = join(claudeDir(), "projects");
  if (!existsSync(projects)) return;
  for (const name of readdirSync(projects)) {
    const old = join(projects, name, `${sid}.jsonl`);
    if (join(projects, name) !== target && existsSync(old)) renameSync(old, `${old}.aside-${Date.now()}`);
  }
}

function writeFiles(target: string, files: PointFile[], parts: Map<string, Buffer>): void {
  for (const f of files) {
    if (f.p === PACK) continue;
    const path = resolve(target, f.p);
    if (!path.startsWith(resolve(target) + sep)) throw refuse("bad_point", `путь файла точки вне папки проекта: ${f.p}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, joined(f, parts));
    renameSync(`${path}.tmp`, path);
  }
}

export async function raise(host: Host, marks: Marks, req: Frame, ctx: Ctx): Promise<unknown> {
  const { sid, point } = req as unknown as { sid: string; point: number };
  if (typeof point !== "number") throw refuse("bad_point", "points.raise без номера точки");
  const dir = clientPath(String(req.dir ?? ""));
  if (!dir) throw refuse("bad_dir", `папка ${String(req.dir)}: нужен путь от ~ или полный`);

  const asked = await host.request("points.get", { to: ".points", ids: [point] });
  if (!asked.ok) throw refuse(asked.error, `реестр не отдал точку ${point}`);
  const { owner, points, links } = asked.result as { owner: string; points: Row[]; links: Record<string, string> };
  const row = points[0];
  if (row.sid !== sid) throw refuse("bad_point", `точка ${point} — другой сессии`);

  const copy = req.copy === true;
  const keep = req.files === "keep";
  const previous = here(host, sid);
  if (!copy && previous && LIVE.has(previous.state)) throw refuse("running", `${previous.info.callsign} ещё идёт`);

  const neighbours = host.sessions().filter((x) => resolve(x.cwd) === resolve(dir) && x.state !== "stopped" && x.callsign !== previous?.info.callsign).map((x) => x.callsign);
  const check = keep ? { folder: "keep", files: 0, branch: null, sessions: [] } : await probe(row.git, dir, neighbours);
  if (req.dryRun === true) return check;
  if (check.folder === "other") throw refuse("bad_dir", `${dir}: другой репозиторий`);

  const parts = await download(row.files, links);
  const pack = row.files.find((f) => f.p === PACK);
  const branch = row.git && !keep ? await place(row.git, dir, check.folder, pack && joined(pack, parts)) : null;
  const target = projectDir(dir);
  if (!copy) setAside(sid, target);
  writeFiles(target, row.files, parts);

  const callsign = await bring(host, req, row, { dir, copy, point, owner, previous });
  const s = host.session(callsign);
  if (!s) throw refuse("open_failed", `${callsign} не поднялась`);
  host.log({ ev: "raise", callsign, sid, point, copy, why: `${callsign}: поднята из точки ${point}` });

  if (copy) {
    // файл источника нужен был только open: разговор копии claude пишет сам; у живой сессии этой машины файл её
    if (!here(host, sid)) rmSync(conversationOf(dir, sid), { force: true });
    marks.mark(s, point);
    return { callsign, point: null, folder: check.folder, branch };
  }
  marks.mark(s);
  let took: Took;
  try {
    took = await capture(host, s, { why: "raise", base: point, expect: owner, ...(ctx.from ? { by: ctx.from } : {}) });
  } catch (e) {
    // сессию уже подняли в другом месте: поднятая здесь лишняя
    marks.leave(callsign);
    await host.request("session.remove", { callsign });
    throw e;
  }
  marks.took(s);

  if (owner !== host.machine && row.callsign) {
    const released = await host.request("session.remove", { callsign: row.callsign });
    if (!released.ok) host.log({ kind: "refuse", ev: "session.remove", word: released.error, callsign: row.callsign, why: `прежний хозяин не отпустил ${row.callsign}` });
  }
  return { callsign, point: took.point, folder: check.folder, branch };
}

/** Сессия на этой машине: откат — запуск той же; иначе новая; сорвалось — прежний хозяин запускается снова. */
async function bring(host: Host, req: Frame, row: Row, o: { dir: string; copy: boolean; point: number; owner: string; previous: Session | undefined }): Promise<string> {
  if (o.previous && !o.copy) {
    const started = await host.request("session.start", { callsign: o.previous.info.callsign, point: o.point });
    if (!started.ok) throw refuse(started.error, `${o.previous.info.callsign} не поднялась из точки`);
    return o.previous.info.callsign;
  }
  const opened = await host.request("session.open", {
    machine: host.machine,
    name: typeof req.name === "string" ? req.name : basename(o.dir),
    dir: req.dir,
    mkdir: true,
    resume: row.sid,
    point: o.point,
    ...(o.copy ? { fork: true } : {}),
    ...(typeof req.slot === "string" ? { slot: req.slot } : {}),
    ...(typeof req.profile === "string" ? { profile: req.profile } : {}),
  });
  if (opened.ok) return (opened.result as { callsign: string }).callsign;
  if (!o.copy && o.owner !== host.machine && row.callsign) await host.request("session.start", { callsign: row.callsign });
  throw refuse(opened.error, `не поднялась: ${opened.error}`);
}
