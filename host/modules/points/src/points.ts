// Модуль points: точки сессий с пометкой «в R2» и подъём сессий из точек.
// Точка — байты файла разговора, файлов рядом и снимка git блоками по 1 МиБ в R2 плюс строка в реестре
// Worker points. Решения — у реестра (хозяин сессии, какие блоки уже есть), байты — у машины.
// Своего у модуля — пометка «в R2» в разделе сессии: { r2: true }.
import { expandDir } from "./dir.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { refuse } from "@switchboard/host";
import type { Host, Module, Result, Session, SessionState } from "@switchboard/host";
import { blocksOf, claudeHome, pack, projectDir, readRef, scan, sha256, unpack } from "./blocks.ts";
import type { PointFile, Ref } from "./blocks.ts";
import { apply, BUNDLE, folderOf, realGit, snapshot } from "./git.ts";
import type { Git, GitSummary } from "./git.ts";
import { getBlock, putBlock } from "./r2.ts";
import type { Creds, Fetch } from "./r2.ts";

/** Конец хода — точка, если с прошлой прошло 2 мин; ход идёт 10 мин без точки — точка посреди хода. */
export const GAP_MS = 2 * 60_000;
export const LONG_MS = 10 * 60_000;

type Mine = { r2?: true };
type Why = "rule" | "save" | "start" | "raise" | "yield";
type Out = { point: number; same: boolean } | { error: string };
/** Строка точки из points.get. */
type Row = { id: number; sid: string; machine: string; callsign?: string; dir?: string; files: PointFile[]; git?: GitSummary; spec?: Record<string, unknown> };

/** Живое правило точек сессии — в памяти: после перезапуска Host считается заново. */
type Live = { last?: number; long?: ReturnType<typeof setTimeout>; gap?: ReturnType<typeof setTimeout>; due?: boolean; idle?: Array<() => void>; turn?: boolean };

const LIVE = new Set<SessionState>(["starting", "idle", "busy", "waiting"]);
const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text: string }).text : "")).join("")
      : "";

/** «Первые слова» точки: 10 последних обменов по 160 знаков. */
export function lastOf(msgs: unknown[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of msgs as Array<{ type?: string; message?: { content?: unknown } }>) {
    const t = text(m?.message?.content).trim();
    if (!t) continue;
    if (m.type === "user") out.push([t.slice(0, 160), ""]);
    else if (m.type === "assistant" && out.length) out[out.length - 1][1] = t.slice(0, 160);
  }
  return out.slice(-10);
}

export function make(deps: { git?: Git; fetch?: Fetch } = {}): Module {
  const git = deps.git ?? realGit;
  const f = (...a: Parameters<Fetch>) => (deps.fetch ?? fetch)(...a);
  let host: Host;
  let stopping = false;
  const live = new Map<string, Live>();
  /** последняя точка не удалась: поле r2 */
  const failed = new Map<string, { error: string; at: number }>();
  /** точки сессии идут по одной */
  const chains = new Map<string, Promise<Out>>();
  /** сессии, которые points.save останавливает сам: их закрытие — не повод */
  const quiet = new Set<string>();
  /** сессии, чью точку старта Host уже сняли */
  const seen = new Set<string>();

  const L = (cs: string) => {
    let x = live.get(cs);
    if (!x) live.set(cs, (x = {}));
    return x;
  };
  const marked = (s: Session) => !!s.store<Mine>().get()?.r2;
  const extra = (r: Result) => r as unknown as Record<string, unknown>;

  function clear(cs: string): void {
    const x = live.get(cs);
    if (x?.long) clearTimeout(x.long);
    if (x?.gap) clearTimeout(x.gap);
    live.delete(cs);
  }

  /** Недостающие блоки — zstd и PUT в R2 прямо с машины. */
  async function upload(missing: string[], creds: Creds, refs: Map<string, Ref>): Promise<void> {
    for (const h of missing) {
      const r = refs.get(h);
      if (!r) throw new Error(`блока ${h} нет на машине`);
      await putBlock(creds, h, pack(readRef(r)), f);
    }
  }

  /** points.put; реестр ответил missing — положить блоки и спросить ещё раз. */
  async function put(frame: Record<string, unknown>, refs: Map<string, Ref>): Promise<Result> {
    let r = await host.request("points.put", frame);
    if (!r.ok && r.error === "missing") {
      const x = extra(r);
      try {
        await upload((x.missing as string[]) ?? [], x.creds as Creds, refs);
      } catch (e) {
        host.log({ kind: "refuse", ev: "r2", word: "r2_failed", callsign: frame.callsign as string, why: (e as Error).message });
        return { ok: false, error: "r2_failed" };
      }
      r = await host.request("points.put", frame);
    }
    return r;
  }

  /** «Снять точку» — одна процедура для всех поводов. */
  async function snapOnce(s: Session, why: Why, more: Record<string, unknown> = {}): Promise<Out> {
    const { callsign, session_id: sid, cwd } = s.info;
    const proj = projectDir(cwd);
    if (!existsSync(join(proj, `${sid}.jsonl`))) return { error: "no_file" };
    const sc = scan(proj, sid);
    const g = await snapshot(git, cwd);
    try {
      if (g?.bundle) sc.files.push(blocksOf(g.bundle, BUNDLE, sc.refs));
      let msgs: number | undefined;
      let last: Array<[string, string]> | undefined;
      try {
        const m = (await s.sdk("getSessionMessages")) as unknown[];
        msgs = m.length;
        last = lastOf(m);
      } catch (e) {
        host.log({ kind: "note", ev: "messages", callsign, why: (e as Error).message });
      }
      const sp = await host.request("session.spec", { v: 1, callsign });
      const frame: Record<string, unknown> = {
        v: 1,
        to: "points",
        sid,
        why,
        files: sc.files,
        callsign,
        dir: cwd,
        bytes: sc.bytes,
        ...(msgs !== undefined ? { msgs, last } : {}),
        ...(g ? { git: g.summary } : {}),
        ...(sp.ok ? { spec: sp.result } : {}),
        ...more,
      };
      let r = await put(frame, sc.refs);
      if (!r.ok && r.error === "not_owner" && why !== "raise") {
        // вернувшийся прежний хозяин: дописанное — веткой, сессию — убрать у себя
        const owner = extra(r).owner;
        host.log({ kind: "note", ev: "yield", callsign, why: `${callsign}: сессией владеет ${String(owner)} — отдаю` });
        r = await put({ ...frame, why: "yield" }, sc.refs);
        const rm = await host.request("session.remove", { v: 1, callsign });
        if (!rm.ok) host.log({ kind: "refuse", ev: "session.remove", word: rm.error, callsign });
        if (!r.ok) return { error: r.error };
        return { point: (r.result as { id: number }).id, same: !!(r.result as { same?: boolean }).same };
      }
      if (!r.ok) return { error: r.error };
      const res = r.result as { id: number; same?: boolean };
      return { point: res.id, same: !!res.same };
    } finally {
      g?.cleanup();
    }
  }

  function snap(s: Session, why: Why, more?: Record<string, unknown>): Promise<Out> {
    const cs = s.info.callsign;
    const prev = chains.get(cs) ?? Promise.resolve({ error: "" } as Out);
    const p = prev.then(async (): Promise<Out> => {
      let out: Out;
      try {
        out = await snapOnce(s, why, more);
      } catch (e) {
        out = { error: (e as Error).message };
      }
      if ("error" in out) {
        failed.set(cs, { error: out.error, at: Math.floor(Date.now() / 1000) });
        host.log({ kind: "refuse", ev: "point", word: out.error, callsign: cs, why: `${cs}: точка (${why}) не снята — ${out.error}` });
      } else {
        failed.delete(cs);
        L(cs).last = Date.now();
      }
      return out;
    });
    chains.set(cs, p);
    return p;
  }

  /** Повод правила: модуль останавливается — новых точек не начинать. */
  function rule(s: Session, why: Why = "rule"): void {
    if (stopping || !marked(s)) return;
    void snap(s, why);
  }

  /** Правило точек по состоянию хода. */
  function onState(s: Session, st: SessionState): void {
    const cs = s.info.callsign;
    if (st === "idle") for (const w of L(cs).idle?.splice(0) ?? []) w();
    if (!marked(s)) return;
    const x = L(cs);
    if (st === "busy" || st === "waiting") {
      x.turn = true;
      if (!x.long) {
        const arm = () => {
          x.long = setTimeout(() => {
            x.long = undefined;
            if (s.state !== "busy" && s.state !== "waiting") return;
            rule(s);
            arm();
          }, LONG_MS);
        };
        arm();
      }
      return;
    }
    if (x.long) clearTimeout(x.long);
    x.long = undefined;
    // конец хода — idle после хода; idle после старта процесса — не повод
    if (st !== "idle" || !x.turn) return;
    x.turn = false;
    const since = x.last === undefined ? Infinity : Date.now() - x.last;
    if (x.due || since >= GAP_MS) {
      x.due = false;
      if (x.gap) clearTimeout(x.gap);
      x.gap = undefined;
      return rule(s);
    }
    // рано: отметка на «2 мин после точки» — тогда свободна — точка, занята — после её хода
    if (!x.gap)
      x.gap = setTimeout(() => {
        x.gap = undefined;
        if (s.state === "idle") rule(s);
        else x.due = true;
      }, GAP_MS - since);
  }

  /** Сессия этой машины с этим sid. */
  function bySid(sid: string): Session | undefined {
    for (const x of host.sessions()) {
      const s = host.session(x.callsign);
      if (s?.info.session_id === sid) return s;
    }
    return undefined;
  }

  /** Собрать файлы точки из R2 в папку проекта. Блок не распаковался или длина не та — bad_point. */
  async function assemble(row: Row, creds: Creds, proj: string, tmp: string): Promise<string | null> {
    let bundle: string | null = null;
    const built: Array<[string, string]> = [];
    for (const pf of row.files) {
      const parts: Buffer[] = [];
      for (const h of pf.b) {
        let raw: Buffer;
        try {
          raw = unpack(await getBlock(creds, h, f));
        } catch (e) {
          if (/R2 GET/.test((e as Error).message)) throw e;
          throw refuse("bad_point", `${pf.p}: блок ${h} не распаковался`);
        }
        if (sha256(raw) !== h) throw refuse("bad_point", `${pf.p}: блок ${h} — другое содержимое`);
        parts.push(raw);
      }
      const body = Buffer.concat(parts);
      if (body.length !== pf.size) throw refuse("bad_point", `${pf.p}: длина ${body.length}, в точке ${pf.size}`);
      const out = join(tmp, String(built.length));
      writeFileSync(out, body);
      if (pf.p === BUNDLE) bundle = out;
      else built.push([pf.p, out]);
    }
    // всё собрано и сверено — теперь на место
    for (const [p, out] of built) {
      const dest = join(proj, ...p.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(out));
    }
    return bundle;
  }

  /** Другие копии файла разговора sid в папке проектов — в сторону: Claude Code ищет его по всем папкам. */
  function asideOthers(sid: string, proj: string): void {
    const root = join(claudeHome(), "projects");
    if (!existsSync(root)) return;
    for (const d of readdirSync(root)) {
      const dir = join(root, d);
      if (resolve(dir) === resolve(proj) || !statSync(dir).isDirectory()) continue;
      const file = join(dir, `${sid}.jsonl`);
      if (existsSync(file)) renameSync(file, `${file}.aside-${Date.now()}`);
    }
  }

  const requests: Module["requests"] = {
    async "session.r2"(fr, ctx) {
      const s = ctx.host.session(String(fr.callsign));
      if (!s) throw refuse("offline", `${String(fr.callsign)}: сессии нет на машине`);
      if (fr.on === true) {
        s.store<Mine>().set({ r2: true });
        const out = await snap(s, "save");
        if ("error" in out) throw refuse(out.error, `${s.info.callsign}: первая точка не снята`);
        return { point: out.point };
      }
      const r = await host.request("points.delete", { v: 1, to: "points", sid: s.info.session_id, ...(ctx.from ? { by: ctx.from } : {}) });
      if (!r.ok) throw refuse(r.error, `${s.info.callsign}: points.delete — пометка стоит`);
      s.store<Mine>().set(undefined);
      clear(s.info.callsign);
      failed.delete(s.info.callsign);
      host.log({ ev: "r2_off", callsign: s.info.callsign, why: `${s.info.callsign}: пометка «в R2» снята, точки удалены из R2` });
      return { deleted: (r.result as { points?: number })?.points ?? 0 };
    },

    async "points.save"(fr) {
      const s = host.session(String(fr.callsign));
      if (!s) throw refuse("offline", `${String(fr.callsign)}: сессии нет на машине`);
      const cs = s.info.callsign;
      if (!marked(s)) throw refuse("not_r2", `${cs}: нет пометки «в R2»`);
      if (fr.stop === true) {
        if (s.state === "waiting" && fr.interrupt !== true) throw refuse("waiting", `${cs}: ждёт ответа человека`);
        // дождаться конца хода; interrupt — ядро прервёт ход само в session.stop
        if (s.state === "busy" && fr.interrupt !== true) await new Promise<void>((r) => (L(cs).idle ??= []).push(r));
        quiet.add(cs);
        const st = await host.request("session.stop", { v: 1, callsign: cs });
        if (!st.ok) {
          quiet.delete(cs);
          throw refuse(st.error, `${cs}: session.stop — ${st.error}`);
        }
      }
      const out = await snap(s, "save");
      quiet.delete(cs);
      if ("error" in out) throw refuse(out.error, `${cs}: точка не снята`);
      return out;
    },

    async "points.raise"(fr) {
      const sid = String(fr.sid ?? "");
      const point = fr.point;
      if (!sid || typeof point !== "number") throw refuse("bad_point", "нужны sid и номер точки");
      const copy = fr.copy === true;
      // «~/папка» с пульта — от домашней папки машины (живой прогон 31 окт.: resolve давал путь от папки выпуска Host)
      const dir = expandDir(String(fr.dir ?? ""));
      const g = await host.request("points.get", { v: 1, to: "points", ids: [point] });
      if (!g.ok) throw refuse(g.error, `points.get ${point}: ${g.error}`);
      const res = g.result as { owner: string | null; points: Row[]; creds: Creds };
      const row = res.points[0];
      if (!row || row.sid !== sid) throw refuse("bad_point", `точка ${point} — не сессии ${sid}`);
      const owner = res.owner ?? row.machine;
      const here = copy ? undefined : bySid(sid);
      const liveIn = host
        .sessions()
        .filter((x) => resolve(x.cwd) === dir && LIVE.has(x.state))
        .map((x) => x.callsign);
      const chk = await folderOf(git, row.git, dir, liveIn);
      const mode = fr.files === "keep" || (fr.files === undefined && here) ? "keep" : "point";
      if (fr.dryRun === true) return chk;
      if (here && LIVE.has(here.state)) throw refuse("running", `${here.info.callsign} идёт здесь — сначала points.save со стопом`);
      if (mode === "point" && chk.folder === "other") throw refuse("bad_dir", `${dir}: другой репозиторий или не репозиторий`);

      const proj = projectDir(dir);
      mkdirSync(proj, { recursive: true });
      const tmp = mkdtempIn();
      let branch: string | null = chk.branch;
      try {
        const bundle = await assemble(row, res.creds, proj, tmp);
        if (!copy) asideOthers(sid, proj);
        if (mode === "point" && row.git && (chk.folder === "same" || chk.folder === "empty")) branch = await apply(git, row.git, dir, chk.folder, bundle);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }

      // сессию открывает manage: своя — start из точки, иначе open с resume
      const name = typeof fr.name === "string" ? fr.name : copy ? basename(dir) : (row.callsign ?? basename(dir)).split("@")[0];
      let callsign: string;
      let opened: Result;
      if (here) {
        callsign = here.info.callsign;
        opened = await host.request("session.start", { v: 1, callsign, point });
      } else {
        opened = await host.request("session.open", {
          v: 1,
          machine: host.machine,
          name,
          dir,
          resume: sid,
          point,
          ...(copy ? { fork: true } : {}),
          ...(fr.slot !== undefined ? { slot: fr.slot } : {}),
          ...(fr.profile !== undefined ? { profile: fr.profile } : {}),
        });
        callsign = opened.ok ? String((opened.result as { callsign: string }).callsign) : "";
      }
      if (!opened.ok) {
        // подъём сорвался: хозяин прежний — его сессия идёт снова
        if (!copy && owner !== host.machine && row.callsign) {
          const back = await host.request("session.start", { v: 1, callsign: row.callsign });
          if (!back.ok) host.log({ kind: "refuse", ev: "session.start", word: back.error, callsign: row.callsign });
        }
        throw refuse(opened.error, `подъём ${sid} из ${point}: ${opened.error}`);
      }
      const s = host.session(callsign);
      if (!s) throw refuse("open_failed", `${callsign}: сессии нет после открытия`);
      s.store<Mine>().set({ r2: true });
      // копия: исходный файл в её папке больше не нужен — разговор уже под новым sid
      if (copy && s.info.session_id !== sid) {
        const src = join(proj, `${sid}.jsonl`);
        if (existsSync(src)) unlinkSync(src);
      }
      const out = await snap(s, "raise", { base: point, ...(copy ? {} : { expect: owner }), ...(fr.by ? { by: fr.by } : {}) });
      if ("error" in out) {
        if (out.error === "not_owner") {
          // сессию уже подняли в другом месте: своя — убрать
          await host.request("session.remove", { v: 1, callsign });
        }
        throw refuse(out.error, `${callsign}: точка подъёма — ${out.error}`);
      }
      if (!copy && owner !== host.machine && row.callsign) {
        const rm = await host.request("session.remove", { v: 1, callsign: row.callsign });
        if (!rm.ok) host.log({ kind: "refuse", ev: "session.remove", word: rm.error, callsign: row.callsign, why: `${row.callsign}: ${rm.error} — прежний хозяин отдаст сессию сам` });
      }
      host.log({ ev: "raise", callsign, sid, point, copy, why: `${callsign}: поднята из точки ${point}` });
      return { callsign, point: out.point, folder: mode === "keep" ? "keep" : chk.folder, branch };
    },
  };

  return {
    requests,
    fields: {
      r2: (s) => (marked(s) ? (failed.get(s.info.callsign) ?? {}) : undefined),
    },
    on: {
      state: onState,
      open(s) {
        // старт Host: точка каждой помеченной сессии — дописанное без связи и смена хозяина
        const cs = s.info.callsign;
        if (seen.has(cs)) return;
        seen.add(cs);
        if (s.info.start === "attach" || s.info.start === "resume") rule(s, "start");
      },
      close(s) {
        const cs = s.info.callsign;
        const x = live.get(cs);
        if (x?.long) clearTimeout(x.long);
        if (x) x.long = undefined;
        if (quiet.has(cs)) return;
        rule(s);
      },
    },
    start(h) {
      host = h;
      stopping = false;
    },
    async stop() {
      // новых точек не начинать, начатые — довести до points.put
      stopping = true;
      for (const cs of [...live.keys()]) clear(cs);
      await Promise.all([...chains.values()]);
    },
  };
}

function mkdtempIn(): string {
  const d = join(tmpdir(), `points-raise-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
