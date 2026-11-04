// Поднять сессию из точки: собрать файлы из R2, разложить папку, открыть сессию через manage, снять точку подъёма, отпустить прежнего хозяина.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { claudeDir, clientPath, refuse } from "@switchboard/host";
import type { Frame, Host, Result, Session, SessionState } from "@switchboard/host";
import { download, projectDir, R2Error } from "./blocks.ts";
import type { Fetch, Links, PointFile } from "./blocks.ts";
import type { Capture } from "./capture.ts";
import { applyToFolder, BUNDLE, checkFolder } from "./git.ts";
import type { GitSummary } from "./git.ts";

/** Строка точки из points.get. */
type Row = { id: number; sid: string; machine: string; callsign?: string; dir?: string; files: PointFile[]; git?: GitSummary };
/** Пометка сессии в её разделе хранилища; base — копия ждёт первого конца хода, чтобы снять точку подъёма с этой базой. */
export type Mark = { r2?: true; base?: number };

const LIVE = new Set<SessionState>(["starting", "idle", "busy", "waiting"]);

/** Файлы точки из R2: всё собрано и сверено — и только тогда на место. Возврат — путь пакета git во временной папке. */
async function restoreFiles(row: Row, links: Links, proj: string, tmp: string, fetcher: Fetch): Promise<string | null> {
  const ready: Array<[string, Buffer]> = [];
  let bundle: string | null = null;
  for (const file of row.files) {
    let body: Buffer;
    try {
      body = await download(file, links, fetcher);
    } catch (e) {
      // сбой R2 — отказ словом, как у сохранения: модуль на машине не выключается
      throw refuse(e instanceof R2Error ? "r2_failed" : "bad_point", `${file.p}: ${(e as Error).message}`);
    }
    if (file.p === BUNDLE) {
      bundle = join(tmp, BUNDLE);
      writeFileSync(bundle, body);
    } else ready.push([file.p, body]);
  }
  for (const [p, body] of ready) {
    const dest = join(proj, ...p.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  return bundle;
}

/** Другие копии файла разговора в папке проектов — в сторону: Claude Code ищет его по всем папкам. */
function setAsideCopies(sid: string, proj: string): void {
  const root = join(claudeDir(), "projects");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (resolve(dir) === resolve(proj) || !statSync(dir).isDirectory()) continue;
    const file = join(dir, `${sid}.jsonl`);
    if (existsSync(file)) renameSync(file, `${file}.aside-${Date.now()}`);
  }
}

function sessionWithSid(host: Host, sid: string): Session | undefined {
  for (const { callsign } of host.sessions()) {
    const s = host.session(callsign);
    if (s?.info.session_id === sid) return s;
  }
  return undefined;
}

export function makeRaise(host: () => Host, capture: Capture, fetcher: Fetch) {
  return async function raise(fr: Frame, from: string | undefined): Promise<unknown> {
    const h = host();
    const sid = String(fr.sid ?? "");
    const point = fr.point;
    if (!sid || typeof point !== "number") throw refuse("bad_point", "нужны sid и номер точки");
    const copy = fr.copy === true;
    // «~/папка» с пульта — от домашней папки машины (живой прогон 31 окт.: resolve давал путь от папки выпуска Host)
    const dir = clientPath(String(fr.dir ?? ""));
    if (!dir) throw refuse("bad_dir", `${String(fr.dir)}: папка не от ~ и не полная`);

    const got = await h.read("points.get", { ids: [point] });
    if (!got.ok) throw refuse(got.error, `points.get ${point}: ${got.error}`);
    const { owner: knownOwner, points, links } = got.result as { owner: string | null; points: Row[]; links?: Links };
    const row = points[0];
    if (!row || row.sid !== sid) throw refuse("bad_point", `точка ${point} — не сессии ${sid}`);
    const owner = knownOwner ?? row.machine;
    const here = copy ? undefined : sessionWithSid(h, sid);
    const neighbours = h.sessions().filter((x) => resolve(x.cwd) === dir && LIVE.has(x.state)).map((x) => x.callsign);
    const check = await checkFolder(row.git, dir, neighbours);
    if (fr.dryRun === true) return check;

    const files = fr.files === "keep" || (fr.files === undefined && here) ? "keep" : "point";
    if (here && LIVE.has(here.state)) throw refuse("running", `${here.info.callsign} идёт здесь — сначала points.save со стопом`);
    if (files === "point" && check.folder === "other") throw refuse("bad_dir", `${dir}: другой репозиторий или не репозиторий`);

    const proj = projectDir(dir);
    mkdirSync(proj, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), "points-raise-"));
    let branch = check.branch;
    try {
      const bundle = await restoreFiles(row, links ?? {}, proj, tmp, fetcher);
      if (!copy) setAsideCopies(sid, proj);
      if (files === "point" && row.git && (check.folder === "same" || check.folder === "empty")) branch = await applyToFolder(row.git, dir, check.folder, bundle);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // сессию открывает manage: своя — start из точки, иначе open с resume
    const name = typeof fr.name === "string" ? fr.name : copy ? basename(dir) : (row.callsign ?? basename(dir)).split("@")[0];
    const opened: Result = here
      ? await h.request("session.start", { callsign: here.info.callsign, point })
      : await h.request("session.open", { machine: h.machine, name, dir, resume: sid, point, ...(copy ? { fork: true } : {}), ...(fr.slot !== undefined ? { slot: fr.slot } : {}), ...(fr.profile !== undefined ? { profile: fr.profile } : {}) });
    const leavesOwner = !copy && owner !== h.machine && !!row.callsign;
    if (!opened.ok) {
      // подъём сорвался: хозяин прежний — его сессия идёт снова
      if (leavesOwner) {
        const back = await h.request("session.start", { callsign: row.callsign });
        if (!back.ok) h.log({ kind: "refuse", ev: "session.start", word: back.error, callsign: row.callsign });
      }
      throw refuse(opened.error, `подъём ${sid} из ${point}: ${opened.error}`);
    }
    const callsign = here ? here.info.callsign : String((opened.result as { callsign: string }).callsign);
    const s = h.session(callsign);
    if (!s) throw refuse("open_failed", `${callsign}: сессии нет после открытия`);
    s.store<Mark>().set({ r2: true });
    const folder = files === "keep" ? "keep" : check.folder;

    if (copy && s.info.session_id !== sid) {
      // разговор копии уже под новым sid: исходный файл в её папке не нужен
      const src = join(proj, `${sid}.jsonl`);
      if (existsSync(src)) unlinkSync(src);
    }
    // файл нового разговора claude пишет только на первом ходу (живой прогон 31 окт.): точка подъёма — на первом конце хода
    if (copy && !existsSync(join(proj, `${s.info.session_id}.jsonl`))) {
      s.store<Mark>().set({ r2: true, base: point });
      h.log({ ev: "raise", callsign, sid, point, copy, why: `${callsign}: копия из точки ${point}; точка подъёма — на первом конце хода` });
      return { callsign, point: null, folder, branch };
    }

    const out = await capture.take(s, "raise", { base: point, ...(copy ? {} : { expect: owner }), ...(from ? { by: from } : {}) });
    if ("error" in out) {
      // сессию уже подняли в другом месте: своя — убрать
      if (out.error === "not_owner") await h.request("session.remove", { callsign });
      throw refuse(out.error, `${callsign}: точка подъёма — ${out.error}`);
    }
    if (leavesOwner) {
      const removed = await h.request("session.remove", { callsign: row.callsign });
      if (!removed.ok) h.log({ kind: "refuse", ev: "session.remove", word: removed.error, callsign: row.callsign, why: `${row.callsign}: ${removed.error} — прежний хозяин отдаст сессию сам` });
    }
    h.log({ ev: "raise", callsign, sid, point, copy, why: `${callsign}: поднята из точки ${point}` });
    return { callsign, point: out.point, folder, branch };
  };
}
