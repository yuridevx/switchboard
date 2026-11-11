// Точки сессий: файлы разговора и пакет git → блоки → архив (points.put двумя шагами, блоки по ссылкам) и подъём сессии из точки.
// Блок — часть файла до 1 МиБ под именем SHA-256 своего содержимого; разговор режется по переводу строки. Тело блока идёт в хранилище сжатым (gzip), имя — хэш несжатого.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { machineOf, pointsGet, pointsPut, pointsSave, Refusal, sessionName, sessionRemove, sessionStart, type Spec } from "@sb/protocol";
import type { Ctx, HostApi, Module, SessionApi } from "../../core/contract.ts";
import { clientPath, claudeDir, tildePath } from "../../core/paths.ts";
import { download, sha256, storeFetch, writeFiles } from "./files.ts";
import { bring, BUNDLE, folderOf, snapshot, type Summary } from "./git.ts";

const BLOCK = 1 << 20;
/** Конец хода — точка не чаще раза в 2 мин; ход идёт 10 мин — точка посреди хода. */
const GAP_MS = 2 * 60_000;
const LONG_MS = 10 * 60_000;
/** Точка не удалась — Host повторит её сам через это время; раньше — при конце хода. */
export const RETRY_MS = 10 * 60_000;
/** Сколько Host сам повторяет неудавшуюся точку, считая от первого сбоя: дальше причина остаётся в строке, повторов нет — решает человек. */
export const WAIT_MS = 6 * 3600_000;
const TITLE = 200;
/** Сколько текста одного сообщения уходит в поиск. */
const TEXT_MAX = 8_000;

type PointFile = { path: string; blocks: string[]; size: number };
type Blocks = Map<string, Buffer>;
/** Сколько ждём конца хода после прерывания перед точкой. */
const INTERRUPT_MS = 30_000;
/** Раздел сессии: последнее сообщение, чей текст уже ушёл в поиск; последняя точка и отпечаток её файлов; причина сбоя последней точки. */
type Mark = { indexed?: string; point?: string; digest?: string; error?: string; /** когда Host сам повторит неудавшуюся точку */ retryAt?: number; /** первый сбой подряд: от него считается предел повторов */ failedAt?: number; /** от какой точки архива поднята: `сессия/точка` */ origin?: string };
type SaveOpts = { label?: string; stop?: boolean; interrupt?: boolean; move?: boolean };

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

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type Said = { type?: string; uuid?: string; message?: { id?: string; model?: string; usage?: Usage; content?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((b: { type?: string; text?: string }) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n") : "";

export function make(o: { retryMs?: number; waitMs?: number } = {}): Module {
  const retryMs = o.retryMs ?? RETRY_MS, waitMs = o.waitMs ?? WAIT_MS;
  let host: HostApi;
  let down = false;
  const lastAt = new Map<string, number>();
  const turns = new Map<string, unknown>();
  /** повтор неудавшейся точки */
  const retries = new Map<string, unknown>();
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

  /** Снять точку сессии: назвать блоки, загрузить недостающие по ссылкам, записать точку. С прошлой точки ничего не изменилось — новая не пишется. */
  async function snap(s: SessionApi, label?: string): Promise<{ point: string; same?: boolean }> {
    if (!existsSync(conversationOf(s))) throw new Refusal("no_file", `${s.callsign}: файла разговора ещё нет`);
    const blocks: Blocks = new Map();
    const files = conversation(s, blocks);
    const git = await snapshot(s.info.cwd);
    // отпечаток: блоки разговора и состояние папки; сам пакет git каждый раз новый и в сравнение не идёт
    const { snap: _snap, ...folder } = git?.summary ?? ({} as Partial<Summary>);
    const digest = sha256(Buffer.from(JSON.stringify([files, folder])));
    const was = markOf(s).get();
    if (was?.point && was.digest === digest && !label) return { point: was.point, same: true };
    if (git?.bundle) files.push(toBlocks(BUNDLE, git.bundle, blocks));
    const { text, last, ...summary } = await summaryOf(s);
    const point = `p${Date.now().toString(36)}`;
    const frame = {
      sid: s.info.sessionId, callsign: s.callsign, point, spec: s.spec,
      // ветка линии: от прошлой точки этой сессии; первая точка поднятой копии — от точки, с которой подняли
      ...(was?.point ? { base: was.point } : was?.origin ? { base: was.origin } : {}),
      ...(label ? { label } : {}), cwd: tildePath(s.info.cwd, homedir()), ...(s.spec.project ? { project: s.spec.project } : {}),
      ...(git ? { git: JSON.stringify(git.summary) } : {}), ...summary, files, ...(text.length ? { text } : {}),
    };
    const first = await host.call(pointsPut, frame);
    if (!first.done) {
      for (const [hash, url] of Object.entries(first.upload)) await storeFetch(url, { method: "PUT", body: new Uint8Array(gzipSync(blocks.get(hash)!)) });
      const second = await host.call(pointsPut, { ...frame, commit: true });
      if (!second.done) throw new Refusal("store_failed", `${s.callsign}: архив не записал точку — не хватает блоков: ${Object.keys(second.upload).length}`);
    }
    markOf(s).update((m) => ({ ...m, ...(last ? { indexed: last } : {}), point, digest }));
    return { point };
  }

  /** Причина сбоя последней точки и час повтора — в строку сессии; удалась — их нет. Повтор — сам, через RETRY_MS; раньше — при конце хода. */
  function mark(s: SessionApi, error: string | undefined): void {
    host.clock.clearTimeout(retries.get(s.callsign));
    retries.delete(s.callsign);
    const was = markOf(s).get();
    const now = host.clock.now();
    const failedAt = error ? (was?.failedAt ?? now) : undefined;
    // повтор — пока не вышел предел от первого сбоя; остановленная сессия повторяет так же: её точка ещё не в архиве
    const retryAt = error && s.spec.backup && !down && now + retryMs <= failedAt! + waitMs ? now + retryMs : undefined;
    if (retryAt) {
      retries.set(s.callsign, host.clock.setTimeout(() => {
        retries.delete(s.callsign);
        if (host.session(s.callsign)) auto(s);
      }, retryMs));
    }
    if (was?.error === error && !was?.retryAt === !retryAt) return;
    markOf(s).update((m) => ({ ...m, error, retryAt, failedAt }));
    if (host.session(s.callsign)) s.sync();
  }

  /** Точка по очереди сессии. */
  function save(s: SessionApi, label?: string): Promise<{ point: string; same?: boolean }> {
    const turn = (queue.get(s.callsign) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try {
        const r = await snap(s, label);
        lastAt.set(s.callsign, host.clock.now());
        host.log.info("point", { callsign: s.callsign, point: r.point, ...(r.same ? { why: "то же, что прошлая" } : {}) });
        mark(s, undefined);
        return r;
      } catch (e) {
        const why = (e as Error).message;
        host.log.warn("point", { callsign: s.callsign, word: e instanceof Refusal ? e.word : "module_failed", why });
        // файла разговора ещё нет — не сбой: первый ход не прошёл
        if (!(e instanceof Refusal && e.word === "no_file")) mark(s, why);
        throw e;
      }
    });
    queue.set(s.callsign, turn);
    return turn;
  }

  /** Точка по запросу: прервать ход перед ней, остановить сессию после; перенос — ведущий с ведомым не отпускается. */
  async function saveNow(s: SessionApi, o: SaveOpts): Promise<{ point: string; same?: boolean }> {
    if (o.move && s.spec.wing) throw new Refusal("has_wing", `${s.callsign} ведёт ${s.spec.wing}: пара не переносится — сначала снимите ведомого`);
    if ((o.interrupt || o.move) && (s.state === "busy" || s.state === "waiting")) {
      await s.sdk("interrupt").catch(() => {});
      const until = Date.now() + INTERRUPT_MS;
      while ((s.state === "busy" || s.state === "waiting") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    }
    if (o.stop || o.move) await s.stop();
    return save(s, o.label);
  }

  /** Точка по правилу машины: сбой — в журнале, запрашивать некому. */
  function auto(s: SessionApi): void {
    if (down || !s.spec.backup || !existsSync(conversationOf(s))) return;
    void save(s).catch(() => {});
  }

  function longTurn(s: SessionApi): void {
    turns.set(s.callsign, host.clock.setTimeout(() => {
      turns.delete(s.callsign);
      auto(s);
      if (s.state === "busy") longTurn(s);
    }, LONG_MS));
  }
  const endTurn = (callsign: string) => {
    host.clock.clearTimeout(turns.get(callsign));
    turns.delete(callsign);
  };

  /** Прежние копии разговора в других папках проектов уходят в сторону: resume находит файл по sid во всех папках. */
  function setAside(sid: string, target: string): void {
    const projects = join(claudeDir(), "projects");
    for (const name of existsSync(projects) ? readdirSync(projects) : []) {
      const old = join(projects, name, `${sid}.jsonl`);
      if (join(projects, name) !== target && existsSync(old)) renameSync(old, `${old}.aside-${Date.now()}`);
    }
  }

  /** Поднять сессию из точки: откат на месте, копия или перенос — один путь: проверка → блоки → папка и файлы → сессия.
   *  dryRun — только проверка папки. files: keep — файлы папки не трогаются, встаёт только разговор.
   *  Перенос: прежняя машина снимает свежую точку и останавливает сессию; поднялась здесь — убирает её у себя, не поднялась — запускает снова. */
  async function raise({ sid, point, name, cwd, move, files: mode = "point", dryRun, slot, expect }: { sid: string; point?: string; name?: string; cwd?: string; move?: boolean; files?: "keep" | "point"; dryRun?: boolean; slot?: string; expect?: string }, ctx: Ctx) {
    // перенос решает хозяин сессии: архив сверяет человека, начавшего его; expect — в архиве та точка, которую человек видел
    let got = await host.call(pointsGet, { sid, ...(point ? { point } : {}), ...(expect ? { expect } : {}), ...(move ? { move: true } : {}), by: ctx.from });
    const origin = got.session.callsign;
    const away = move && machineOf(origin) !== host.machine;
    let released = false;
    if (away && !dryRun && !point) {
      // прежняя машина отпускает: свежая точка и остановка. Не на связи — берём последнюю точку архива: машина могла умереть
      try {
        const fresh = await host.call(pointsSave, { to: origin, move: true }, { from: ctx.from, trace: ctx.trace });
        released = true;
        got = await host.call(pointsGet, { sid, point: fresh.point });
      } catch (e) {
        const r = e as Refusal;
        if (r.word !== "offline" && r.word !== "timeout" && r.word !== "not_found") throw e;
        ctx.log.warn("raise_release", { callsign: origin, word: r.word, why: `прежняя машина не отпустила — поднимаю последнюю точку архива: ${r.why ?? r.message}` });
      }
    }
    try {
      return await bringUp(got, { name, cwd, move, mode, dryRun, slot }, ctx);
    } catch (e) {
      // не поднялась — прежняя машина запускает сессию снова
      if (released) await host.call(sessionStart, { to: origin }, { from: ctx.from, trace: ctx.trace }).catch((x: unknown) => ctx.log.warn("raise_return", { callsign: origin, why: (x as Error).message }));
      throw e;
    }
  }

  async function bringUp(got: Awaited<ReturnType<typeof host.call<typeof pointsGet>>>, { name, cwd, move, mode, dryRun, slot }: { name?: string; cwd?: string; move?: boolean; mode: "keep" | "point"; dryRun?: boolean; slot?: string }, ctx: Ctx) {
    const sid = got.session.sid;
    const where = cwd ?? got.session.cwd;
    const dir = where ? clientPath(where, homedir()) : null;
    if (!dir) throw new Refusal("bad_dir", `папка ${where}: нужен путь от ~ или полный`);
    const here = host.sessions().find((s) => s.info.sessionId === sid);
    if (here && here.state !== "stopped" && here.state !== "failed") throw new Refusal("running", `${here.callsign} ещё идёт: остановите её перед откатом`);
    const git = got.point.git ? (JSON.parse(got.point.git) as Summary) : undefined;
    const near = host.sessions().filter((s) => resolve(s.info.cwd) === resolve(dir) && s.state !== "stopped" && s !== here).map((s) => s.callsign);
    const check = await folderOf(dir, git, near);
    if (dryRun) return { check: { ...check, dir: tildePath(dir, homedir()) } };
    if (check.folder === "other") throw new Refusal("bad_dir", `${dir}: другой репозиторий`);
    // сохранение этой сессии ещё идёт — дождаться: блоки точки могут быть в пути
    if (here) await queue.get(here.callsign)?.catch(() => {});
    const files = await download(got.files);
    if (mode === "point" && git && (check.folder === "empty" || check.folder === "same")) await bring(dir, git, check.folder, files.get(BUNDLE));
    mkdirSync(dir, { recursive: true });
    const target = projectDir(dir);
    setAside(sid, target);
    writeFiles(target, files, [BUNDLE]);
    // откат: та же сессия запускается с файлами точки
    if (here) {
      await here.start();
      ctx.log.info("raise", { callsign: here.callsign, sid, point: got.point.point, why: "откат на месте" });
      return { callsign: here.callsign };
    }
    // перенос — тот же разговор продолжает здесь; копия — новый разговор от файла точки
    // документ — тот, с каким сессия сохранялась: кусочки, модель, режим, аккаунт; пара и родитель остаются на прежнем месте
    const { wing: _wing, parent: _parent, ...kept } = got.session.spec ?? ({} as Partial<Spec>);
    const spec: Spec = { ...kept, name: name ?? sessionName(got.session.callsign) ?? basename(dir), cwd: tildePath(dir, homedir()), backup: true, ...(got.session.project ? { project: got.session.project } : {}), ...(slot ? { slot } : {}) };
    const s = await host.open(spec, { by: ctx.from, resume: sid, fork: !move });
    // ветка линии: перенос продолжает точку своей же сессии, копия — точку чужой
    markOf(s).update((m) => ({ ...m, ...(move ? { point: got.point.point } : { origin: `${sid}/${got.point.point}` }) }));
    ctx.log.info("raise", { callsign: s.callsign, sid, point: got.point.point, why: move ? "перенос" : "копия" });
    if (move && machineOf(got.session.callsign) !== host.machine) {
      // прежняя машина убирает сессию у себя; не на связи — отказ в журнале, сессию там уберёт человек
      await host.call(sessionRemove, { to: got.session.callsign }, { from: ctx.from }).catch((e: unknown) => ctx.log.warn("raise_release", { callsign: got.session.callsign, why: (e as Error).message }));
    }
    return { callsign: s.callsign };
  }

  return {
    name: "host-points",
    spec: { backup() {} },
    row(s) {
      const { error, retryAt, failedAt } = markOf(s).get() ?? {};
      return error ? { archiveError: error, ...(retryAt ? { archiveRetryAt: retryAt } : {}), ...(failedAt ? { archiveUntil: failedAt + waitMs } : {}) } : {};
    },
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
        if (host.clock.now() - (lastAt.get(cs) ?? 0) >= GAP_MS) auto(s);
      },
      removed(cs) {
        endTurn(cs);
        host.clock.clearTimeout(retries.get(cs));
        retries.delete(cs);
        lastAt.delete(cs);
        queue.delete(cs);
      },
    },
    requests: {
      "points.save": ({ to, ...o }: { to: string } & SaveOpts) => saveNow(host.session(to)!, o),
      "points.raise": raise,
    },
    start(h) {
      host = h;
    },
    async stop() {
      down = true;
      for (const timer of [...turns.values(), ...retries.values()]) host.clock.clearTimeout(timer);
      await Promise.allSettled(queue.values());
    },
  };
}
