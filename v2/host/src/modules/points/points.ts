// Точки сессий: файлы разговора и пакет git → блоки → архив (points.put двумя шагами, блоки по ссылкам) и подъём сессии из точки.
// Блок — часть файла до 1 МиБ под именем SHA-256 своего содержимого; разговор режется по переводу строки. Тело блока идёт как есть.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CALL_MS, machineOf, pointsGet, pointsPut, Refusal, sessionName, sessionRemove, type Spec } from "@sb/protocol";
import type { Ctx, HostApi, Module, SessionApi } from "../../core/contract.ts";
import { clientPath, claudeDir, tildePath } from "../../core/paths.ts";
import { bring, BUNDLE, folderOf, snapshot, type Summary } from "./git.ts";

const BLOCK = 1 << 20;
/** Конец хода — точка не чаще раза в 2 мин; ход идёт 10 мин — точка посреди хода. */
const GAP_MS = 2 * 60_000;
const LONG_MS = 10 * 60_000;
const TITLE = 200;
/** Сколько текста одного сообщения уходит в поиск. */
const TEXT_MAX = 8_000;

type PointFile = { path: string; blocks: string[]; size: number };
type Blocks = Map<string, Buffer>;
/** Раздел сессии: последнее сообщение, чей текст уже ушёл в поиск. */
type Mark = { indexed?: string };

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Папка проекта рабочей папки: так её называет Claude Code. */
export const projectDir = (cwd: string) => join(claudeDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

/** Конец блока с off: у разговора — последний перевод строки до 1 МиБ, чтобы каждая строка блока была целой записью; строка длиннее — целиком. */
function endOf(buf: Buffer, off: number, size: number, lines: boolean): number {
  const end = Math.min(size, off + BLOCK);
  if (!lines || end === size) return end;
  const nl = buf.lastIndexOf(0x0a, end - 1);
  return nl >= off ? nl + 1 : buf.indexOf(0x0a, end) + 1 || size;
}

/** Файл блоками; разговор — по последний перевод строки: хвост ещё дописывается. */
export function toBlocks(path: string, buf: Buffer, blocks: Blocks): PointFile {
  const lines = path.endsWith(".jsonl");
  const size = lines ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const list: string[] = [];
  for (let off = 0, end = 0; off < size; off = end) {
    end = endOf(buf, off, size, lines);
    const part = buf.subarray(off, end);
    const hash = sha256(part);
    list.push(hash);
    blocks.set(hash, part);
  }
  return { path, size, blocks: list };
}

/** Запрос к хранилищу по ссылке: сеть или отказ — слово store_failed. */
async function storeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) }).catch((e) => {
    throw new Refusal("store_failed", `хранилище: ${e}`);
  });
  if (!res.ok) throw new Refusal("store_failed", `хранилище ответило ${res.status}`);
  return res;
}

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type Said = { type?: string; uuid?: string; message?: { id?: string; model?: string; usage?: Usage; content?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((b: { type?: string; text?: string }) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n") : "";

export function make(): Module {
  let host: HostApi;
  let down = false;
  const lastAt = new Map<string, number>();
  const turns = new Map<string, ReturnType<typeof setTimeout>>();
  /** точки одной сессии идут по очереди */
  const queue = new Map<string, Promise<unknown>>();
  const markOf = (s: SessionApi) => s.store<Mark>();
  const conversationOf = (s: SessionApi) => join(projectDir(s.info.cwd), `${s.info.sessionId}.jsonl`);

  /** Разговор и файлы рядом с ним: подагенты и прочее в папке сессии. */
  function conversation(s: SessionApi, blocks: Blocks): PointFile[] {
    const dir = projectDir(s.info.cwd);
    const sid = s.info.sessionId;
    const side = join(dir, sid);
    const names = existsSync(side) ? readdirSync(side, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/")) : [];
    return [`${sid}.jsonl`, ...names.sort()].map((p) => toBlocks(p, readFileSync(join(dir, p)), blocks));
  }

  /** Сводка сессии в строке точки и текст новых сообщений для поиска. */
  async function summaryOf(s: SessionApi) {
    try {
      const messages = (await s.sdk("getSessionMessages")) as Said[];
      const info = (await s.sdk("getSessionInfo")) as { summary?: string; customTitle?: string; firstPrompt?: string } | undefined;
      const title = info?.customTitle ?? info?.summary ?? info?.firstPrompt;
      const seen = new Set<string>();
      let tokens = 0;
      let turns = 0;
      let model: string | undefined;
      for (const m of messages) {
        if (m.type === "user" && typeof m.message?.content === "string") turns++;
        if (m.type !== "assistant" || !m.message?.usage) continue;
        const { id, usage: u, model: said } = m.message;
        if (said && said !== "<synthetic>") model = said;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
      }
      // в поиск — только то, чего там ещё нет
      const from = markOf(s).get()?.indexed;
      const at = from ? messages.findIndex((m) => m.uuid === from) : -1;
      const text = messages.slice(at + 1).flatMap((m) => {
        const t = m.type === "user" || m.type === "assistant" ? textOf(m.message?.content) : "";
        return t && m.uuid ? [{ uuid: m.uuid, role: m.type!, text: t.slice(0, TEXT_MAX) }] : [];
      });
      return { turns, tokens, ...(title ? { title: title.slice(0, TITLE) } : {}), ...(model ? { model } : {}), text, last: messages.at(-1)?.uuid };
    } catch (e) {
      host.log.warn("point_summary", { callsign: s.callsign, why: (e as Error).message });
      return { text: [] as Array<{ uuid: string; role: string; text: string }>, last: undefined };
    }
  }

  /** Снять точку сессии: назвать блоки, загрузить недостающие по ссылкам, записать точку. */
  async function snap(s: SessionApi, label?: string): Promise<string> {
    if (!existsSync(conversationOf(s))) throw new Refusal("no_file", `${s.callsign}: файла разговора ещё нет`);
    const blocks: Blocks = new Map();
    const files = conversation(s, blocks);
    const git = await snapshot(s.info.cwd);
    if (git?.bundle) files.push(toBlocks(BUNDLE, git.bundle, blocks));
    const { text, last, ...summary } = await summaryOf(s);
    const point = `p${Date.now().toString(36)}`;
    const frame = {
      sid: s.info.sessionId, callsign: s.callsign, point, ...(label ? { label } : {}), cwd: tildePath(s.info.cwd, homedir()), ...(s.spec.project ? { project: s.spec.project } : {}),
      ...(git ? { git: JSON.stringify(git.summary) } : {}), ...summary, files, ...(text.length ? { text } : {}),
    };
    const first = await host.call(pointsPut, frame);
    if (!first.done) {
      for (const [hash, url] of Object.entries(first.upload)) await storeFetch(url, { method: "PUT", body: new Uint8Array(blocks.get(hash)!) });
      const second = await host.call(pointsPut, { ...frame, commit: true });
      if (!second.done) throw new Refusal("store_failed", `${s.callsign}: архив не записал точку — не хватает блоков: ${Object.keys(second.upload).length}`);
    }
    if (last) markOf(s).update((m) => ({ ...m, indexed: last }));
    return point;
  }

  /** Точка по очереди сессии. */
  function save(s: SessionApi, label?: string): Promise<string> {
    const turn = (queue.get(s.callsign) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try {
        const point = await snap(s, label);
        lastAt.set(s.callsign, Date.now());
        host.log.info("point", { callsign: s.callsign, point });
        return point;
      } catch (e) {
        host.log.warn("point", { callsign: s.callsign, word: e instanceof Refusal ? e.word : "module_failed", why: (e as Error).message });
        throw e;
      }
    });
    queue.set(s.callsign, turn);
    return turn;
  }

  /** Точка по правилу машины: сбой — в журнале, запрашивать некому. */
  function auto(s: SessionApi): void {
    if (down || !s.spec.backup || !existsSync(conversationOf(s))) return;
    void save(s).catch(() => {});
  }

  function longTurn(s: SessionApi): void {
    const timer = setTimeout(() => {
      turns.delete(s.callsign);
      auto(s);
      if (s.state === "busy") longTurn(s);
    }, LONG_MS);
    timer.unref();
    turns.set(s.callsign, timer);
  }
  const endTurn = (callsign: string) => {
    clearTimeout(turns.get(callsign));
    turns.delete(callsign);
  };

  /** Блоки точки по ссылкам: каждый сверен по SHA-256; файлы на диске трогаются, только когда все на руках. */
  async function download(files: Array<{ path: string; blocks: Array<{ hash: string; url: string }> }>): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    for (const f of files) {
      const parts: Buffer[] = [];
      for (const b of f.blocks) {
        const buf = Buffer.from(await (await storeFetch(b.url)).arrayBuffer());
        if (sha256(buf) !== b.hash) throw new Refusal("bad_point", `${f.path}: блок ${b.hash.slice(0, 12)} пришёл не тот`);
        parts.push(buf);
      }
      out.set(f.path, Buffer.concat(parts));
    }
    return out;
  }

  /** Файлы точки в папку проекта: путь из архива не выходит из неё, файл появляется целиком. */
  function writeFiles(target: string, files: Map<string, Buffer>): void {
    const paths = [...files.keys()].filter((p) => p !== BUNDLE).map((p) => [p, resolve(target, p)] as const);
    for (const [p, file] of paths) if (!file.startsWith(resolve(target) + sep)) throw new Refusal("bad_point", `путь файла точки вне папки проекта: ${p}`);
    for (const [p, file] of paths) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, files.get(p)!);
      renameSync(`${file}.tmp`, file);
    }
  }

  /** Прежние копии разговора в других папках проектов уходят в сторону: resume находит файл по sid во всех папках. */
  function setAside(sid: string, target: string): void {
    const projects = join(claudeDir(), "projects");
    for (const name of existsSync(projects) ? readdirSync(projects) : []) {
      const old = join(projects, name, `${sid}.jsonl`);
      if (join(projects, name) !== target && existsSync(old)) renameSync(old, `${old}.aside-${Date.now()}`);
    }
  }

  /** Поднять сессию из точки: откат на месте, копия или перенос — один путь: проверка → блоки → папка и файлы → сессия. */
  async function raise({ sid, point, name, cwd, move }: { sid: string; point?: string; name?: string; cwd?: string; move?: boolean }, ctx: Ctx) {
    const got = await host.call(pointsGet, { sid, ...(point ? { point } : {}) });
    const where = cwd ?? got.session.cwd;
    const dir = where ? clientPath(where, homedir()) : null;
    if (!dir) throw new Refusal("bad_dir", `папка ${where}: нужен путь от ~ или полный`);
    const here = host.sessions().find((s) => s.info.sessionId === sid);
    if (here && here.state !== "stopped" && here.state !== "failed") throw new Refusal("running", `${here.callsign} ещё идёт: остановите её перед откатом`);
    const git = got.point.git ? (JSON.parse(got.point.git) as Summary) : undefined;
    const near = host.sessions().filter((s) => resolve(s.info.cwd) === resolve(dir) && s.state !== "stopped" && s !== here).map((s) => s.callsign);
    const check = await folderOf(dir, git, near);
    if (check.folder === "other") throw new Refusal("bad_dir", `${dir}: другой репозиторий`);
    const files = await download(got.files);
    if (git && (check.folder === "empty" || check.folder === "same")) await bring(dir, git, check.folder, files.get(BUNDLE));
    mkdirSync(dir, { recursive: true });
    const target = projectDir(dir);
    setAside(sid, target);
    writeFiles(target, files);
    // откат: та же сессия запускается с файлами точки
    if (here) {
      await here.start();
      ctx.log.info("raise", { callsign: here.callsign, sid, point: got.point.point, why: "откат на месте" });
      return { callsign: here.callsign };
    }
    // перенос — тот же разговор продолжает здесь; копия — новый разговор от файла точки
    const spec: Spec = { name: name ?? sessionName(got.session.callsign) ?? basename(dir), cwd: tildePath(dir, homedir()), backup: true, ...(got.session.project ? { project: got.session.project } : {}) };
    const s = await host.open(spec, { by: ctx.from, resume: sid, fork: !move });
    ctx.log.info("raise", { callsign: s.callsign, sid, point: got.point.point, why: move ? "перенос" : "копия" });
    if (move && machineOf(got.session.callsign) !== host.machine) {
      // прежняя машина отпускает сессию; не на связи — отказ в журнале, сессию там уберёт человек
      await host.call(sessionRemove, { to: got.session.callsign }, { from: ctx.from }).catch((e: unknown) => ctx.log.warn("raise_release", { callsign: got.session.callsign, why: (e as Error).message }));
    }
    return { callsign: s.callsign };
  }

  return {
    name: "host-points",
    spec: { backup() {} },
    applied(s, keys) {
      if (keys.includes("backup")) auto(s);
    },
    on: {
      state(s, state) {
        const cs = s.callsign;
        if (state === "busy" && !turns.has(cs) && s.spec.backup) longTurn(s);
        if (state === "stopped") {
          endTurn(cs);
          auto(s);
        }
        if (state !== "idle") return;
        endTurn(cs);
        if (Date.now() - (lastAt.get(cs) ?? 0) >= GAP_MS) auto(s);
      },
      removed(cs) {
        endTurn(cs);
        lastAt.delete(cs);
        queue.delete(cs);
      },
    },
    requests: {
      async "points.save"({ to, label }: { to: string; label?: string }) {
        return { point: await save(host.session(to)!, label) };
      },
      "points.raise": raise,
    },
    start(h) {
      host = h;
    },
    async stop() {
      down = true;
      for (const timer of turns.values()) clearTimeout(timer);
      await Promise.allSettled(queue.values());
    },
  };
}
