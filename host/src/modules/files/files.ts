// Файлы сессии: отправить человеку файл из папки (file.send), поднять папку сайтом (site.publish) и принять файлы сообщения в папку сессии.
// Содержимое лежит в хранилище флота под своим хэшем; в разговоре, ленте и журнале — имя, хэш и размер. Свой шаг один: посчитать хэш →
// спросить у службы, чего в хранилище нет → загрузить недостающее по ссылке; в обратную сторону — скачать по ссылке и сверить хэш.
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CALL_MS, filesGet, filesPut, filesSite, Refusal, type FileIn } from "@sb/protocol";
import type { Ctx, HostApi, Module, SessionApi } from "../../core/contract.ts";
import { fileHash, sha256, storeInto, storePut } from "./store.ts";

/** Папка внутри папки сессии, куда встают файлы сообщений: файлы проекта не затираются. */
const UPLOADS = "uploads";
/** Строка уведомления в тексте сообщения — единственная запись о его файлах в разговоре. Собирает и разбирает её только этот модуль. */
const NOTE = "Загружены файлы в папку сессии:";
const LINE = /^- (.+) · (\d+) байт · sha256 ([0-9a-f]{64})$/;

/** Что модуль файлов отдаёт соседям этого Host. */
export type FilesApi = {
  /** Содержимое — в хранилище, если его там ещё нет. */
  put(name: string, body: Buffer, signal: AbortSignal): Promise<FileIn>;
  /** Файлы сообщения — в папку сессии: скачать, сверить хэш, поставить в uploads/. Ответ — текст сообщения со строкой уведомления о них. */
  attach(s: SessionApi, text: string, files: FileIn[], signal: AbortSignal): Promise<string>;
};

/** Текст сообщения без строки уведомления и файлы из неё; строки нет — null. Лента и история получают разобранное: страница строку не разбирает. */
export function split(text: string): { text: string; files: FileIn[] } | null {
  const at = text.lastIndexOf(NOTE);
  if (at < 0 || (at > 0 && !text.slice(0, at).endsWith("\n\n"))) return null;
  const lines = text.slice(at + NOTE.length).split("\n").filter(Boolean).map((l) => LINE.exec(l));
  if (!lines.length || lines.some((l) => !l)) return null;
  return { text: at ? text.slice(0, at - 2) : "", files: lines.map((l) => ({ name: l![1]!.split("/").pop()!, hash: l![3]!, size: Number(l![2]) })) };
}

/** Имя файла на диске: без пути и без знаков, которых не терпит Windows. */
const diskName = (name: string) => basename(name.replaceAll("\\", "/")).replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+$/, "") || "file";

export function make(o: { limitMs?: number } = {}): Module {
  const limitMs = o.limitMs ?? CALL_MS;
  let host: HostApi;
  /** Предел действия с файлом — предел запроса флота; остановка Host обрывает его раньше. */
  const limit = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(limitMs)]);

  /** Отправить и поднять сайт можно только от себя. */
  function own(to: string, ctx: Ctx): SessionApi {
    if (ctx.from !== to) throw new Refusal("not_self", `${to}: файл и сайт идут только в свою ленту — to должен быть твоим позывным (${ctx.from})`);
    return host.session(to)!;
  }

  /** Путь от сессии: от её папки, от домашней («~/…») или полный. */
  const pathOf = (s: SessionApi, p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(s.info.cwd, p));

  /** Хэши, которых в хранилище нет, — туда; read — содержимое по хэшу. Ответ — сколько загружено. */
  async function upload(files: Array<{ hash: string; size: number }>, read: (hash: string) => Buffer, signal: AbortSignal): Promise<number> {
    const { upload: links } = await host.call(filesPut, { files });
    for (const [hash, url] of Object.entries(links)) await storePut(url, read(hash), signal);
    return Object.keys(links).length;
  }

  async function put(name: string, body: Buffer, signal: AbortSignal): Promise<FileIn> {
    const file = { name, hash: sha256(body), size: body.length };
    await upload([file], () => body, limit(signal));
    return file;
  }

  /** Место файла в uploads/: своё имя; занято другим содержимым — рядом, с номером; то же содержимое уже лежит — оно и есть. */
  function slot(dir: string, f: FileIn): { file: string; have: boolean } {
    const name = diskName(f.name);
    const ext = extname(name), stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n++) {
      const file = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
      if (!existsSync(file)) return { file, have: false };
      if (statSync(file).isFile() && statSync(file).size === f.size && fileHash(file) === f.hash) return { file, have: true };
    }
  }

  async function attach(s: SessionApi, text: string, files: FileIn[], signal: AbortSignal): Promise<string> {
    const dir = join(s.info.cwd, UPLOADS);
    const within = limit(signal);
    const lines: string[] = [];
    for (const f of files) {
      const t0 = host.clock.now();
      const { file, have } = slot(dir, f);
      if (!have) {
        // содержимое идёт в черновик по хэшу и встаёт под своим именем только целым и сверенным. Не уложилось в предел запроса —
        // принятое остаётся: повтор сообщения докачивает остальное, большой файл на медленной сети приходит за несколько запросов
        const part = join(dir, `.${f.hash}.part`);
        const { url } = await host.call(filesGet, { hash: f.hash });
        await storeInto(url, part, within).catch((e: unknown) => {
          if (!(e instanceof Refusal) || !existsSync(part)) throw e;
          throw new Refusal(e.word, `${f.name}: принято ${statSync(part).size} из ${f.size} байт — повторите сообщение, файл докачается (${e.why})`);
        });
        if (fileHash(part) !== f.hash) {
          rmSync(part);
          throw new Refusal("bad_file", `${f.name}: из хранилища пришло не то содержимое — в папку сессии не записано`);
        }
        renameSync(part, file);
      }
      const path = relative(s.info.cwd, file).split(sep).join("/");
      host.log.info("file_upload", { callsign: s.callsign, name: path, hash: f.hash, size: f.size, ms: host.clock.now() - t0, ...(have ? { why: "то же содержимое уже в папке" } : {}) });
      lines.push(`- ${path} · ${f.size} байт · sha256 ${f.hash}`);
    }
    return `${text ? `${text}\n\n` : ""}${NOTE}\n${lines.join("\n")}`;
  }

  /** Файлы папки сайта: путь через «/» от папки. Имена с точки и node_modules в сайт не идут. */
  function walk(root: string): Array<{ path: string; file: string }> {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ file: join(e.parentPath, e.name), path: relative(root, join(e.parentPath, e.name)).split(sep).join("/") }))
      .filter((f) => !f.path.split("/").some((part) => part.startsWith(".") || part === "node_modules"))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** Номер сайта выводится, а не запоминается: секрет машины, позывной и папка. Та же сессия и та же папка — тот же адрес; без секрета номер не подобрать. */
  const siteId = (callsign: string, root: string) => createHmac("sha256", host.key).update(`${callsign}\n${resolve(root)}`).digest("hex").slice(0, 32);

  return {
    name: "host-files",
    start(h) {
      host = h;
    },
    api: { put, attach } satisfies FilesApi,
    requests: {
      async "file.send"({ to, path, title }: { to: string; path: string; title?: string }, ctx: Ctx) {
        const s = own(to, ctx);
        const t0 = host.clock.now();
        const file = pathOf(s, path);
        if (!existsSync(file) || !statSync(file).isFile()) throw new Refusal("no_file", `${path}: такого файла нет`);
        const out = await put(basename(file), readFileSync(file), ctx.signal);
        ctx.log.info("file_send", { callsign: to, ...out, ms: host.clock.now() - t0, ...(title ? { title } : {}) });
        return out;
      },

      async "site.publish"({ to, dir, title }: { to: string; dir: string; title?: string }, ctx: Ctx) {
        const s = own(to, ctx);
        const t0 = host.clock.now();
        const root = pathOf(s, dir);
        if (!existsSync(join(root, "index.html"))) throw new Refusal("no_index", `${dir}: в папке нет index.html`);
        const byHash = new Map<string, string>();
        const files = walk(root).map(({ path, file }) => {
          const body = readFileSync(file);
          const hash = sha256(body);
          byHash.set(hash, file);
          return { path, hash, size: body.length };
        });
        const sent = await upload([...byHash.keys()].map((hash) => ({ hash, size: files.find((f) => f.hash === hash)!.size })), (hash) => readFileSync(byHash.get(hash)!), limit(ctx.signal));
        const site = siteId(to, root);
        const { url } = await host.call(filesSite, { site, files });
        const size = files.reduce((n, f) => n + f.size, 0);
        ctx.log.info("site_publish", { callsign: to, site, files: files.length, size, sent, ms: host.clock.now() - t0, ...(title ? { title } : {}) });
        return { url, files: files.length, size };
      },
    },
  };
}
