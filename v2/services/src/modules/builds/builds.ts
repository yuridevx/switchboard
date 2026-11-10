// Выпуски: сборки по номеру в R2 и строка флота — какая сборка стоит и какие машины закреплены на другой. Сам ничего не собирает: собирает CI.
import { Refusal } from "@sb/protocol";
import type { Ctx, Env, Module } from "../../env.ts";
import { link } from "../../r2.ts";
import { records } from "../../records.ts";
import { record } from "../ledger/contract.ts";

const NAME = "builds";
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS fleet (one INTEGER PRIMARY KEY CHECK (one = 1), stable INTEGER, pins TEXT NOT NULL)",
  "INSERT OR IGNORE INTO fleet (one, stable, pins) VALUES (1, NULL, '{}')",
  "CREATE TABLE IF NOT EXISTS builds (build INTEGER PRIMARY KEY, at INTEGER, sha TEXT, note TEXT, files TEXT NOT NULL)",
  // отпечаток кода сборки: сверка «в дереве то же, что загружено»
  "CREATE TABLE IF NOT EXISTS digests (build INTEGER PRIMARY KEY, digest TEXT NOT NULL)",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

type File = { name: string; sha256: string; size: number };
type Stored = { build: number; at: number; sha: string | null; note: string | null; files: string };
type FleetRow = { stable: number | null; pins: string };

/** Ключ файла сборки: у флота свои сборки. */
const fileKey = (fleet: string, build: number, name: string) => `builds/${fleet}/${build}/${name}`;
/** Имя файла Keeper по ОС и процессору. */
export const keeperFile = (os: string, arch = "amd64") => `keeper-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
export const HOST_FILE = "host.tgz";

const fleetRow = async (ctx: Ctx) => (await db(ctx.env, ctx.fleet).first<FleetRow>("SELECT stable, pins FROM fleet WHERE one = 1"))!;

export const builds: Module = {
  name: NAME,
  handlers: {
    async "builds.list"(_i, ctx) {
      const [row, rows, sums] = await Promise.all([fleetRow(ctx), db(ctx.env, ctx.fleet).all<Stored>("SELECT * FROM builds ORDER BY build DESC LIMIT 100"), db(ctx.env, ctx.fleet).all<{ build: number; digest: string }>("SELECT build, digest FROM digests")]);
      const digest = new Map(sums.map((d) => [d.build, d.digest]));
      return {
        stable: row.stable,
        pins: JSON.parse(row.pins),
        builds: rows.map((b) => ({ build: b.build, at: b.at, ...(b.sha ? { commit: b.sha } : {}), ...(b.note ? { note: b.note } : {}), ...(digest.has(b.build) ? { digest: digest.get(b.build)! } : {}), files: (JSON.parse(b.files) as File[]).map((f) => f.name) })),
      };
    },

    async "builds.upload"(i: { build: number; commit?: string; note?: string; digest?: string; files: File[] }, ctx) {
      if (i.digest) await db(ctx.env, ctx.fleet).run("INSERT OR REPLACE INTO digests (build, digest) VALUES (?, ?)", i.build, i.digest);
      await db(ctx.env, ctx.fleet).run("INSERT OR REPLACE INTO builds (build, at, sha, note, files) VALUES (?, ?, ?, ?, ?)", i.build, Date.now(), i.commit ?? null, i.note ?? null, JSON.stringify(i.files));
      const links: Record<string, string> = {};
      for (const f of i.files) links[f.name] = await link(ctx.env, "PUT", fileKey(ctx.fleet, i.build, f.name));
      return { links };
    },

    async "builds.deploy"(i: { build: number | null; machine?: string }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      if (i.build !== null && !(await d.first("SELECT 1 FROM builds WHERE build = ?", i.build))) throw new Refusal("not_found", `сборки ${i.build} нет`);
      if (i.machine) {
        // закрепление машины; build null — снять
        await d.run("UPDATE fleet SET pins = json_patch(pins, ?) WHERE one = 1", JSON.stringify({ [i.machine]: i.build }));
      } else {
        if (i.build === null) throw new Refusal("bad_input", "флоту нужна сборка: build — номер");
        await d.run("UPDATE fleet SET stable = ? WHERE one = 1", i.build);
      }
      const told = await ctx.platform.broadcast(ctx.fleet, { type: "plan.changed", trace: ctx.trace }, "keeper");
      await record(ctx.env, ctx.fleet, { what: "builds.deploy", who: ctx.who.addr, machine: i.machine, text: i.build === null ? "закрепление снято" : `сборка ${i.build}`, data: { build: i.build, told }, trace: ctx.trace });
      return {};
    },

    async "builds.keeper"(i: { os: string; arch?: string }, ctx) {
      const row = await fleetRow(ctx);
      if (row.stable == null) throw new Refusal("not_found", "флоту не назначена сборка");
      const b = await db(ctx.env, ctx.fleet).first<Stored>("SELECT * FROM builds WHERE build = ?", row.stable);
      const name = keeperFile(i.os, i.arch);
      const f = (JSON.parse(b?.files ?? "[]") as File[]).find((x) => x.name === name);
      if (!f) throw new Refusal("not_found", `в сборке ${row.stable} нет файла ${name}`);
      const url = await link(ctx.env, "GET", fileKey(ctx.fleet, row.stable, name));
      // приглашение идёт первой строкой ввода: в команде его нет
      const command = i.os === "windows"
        ? `curl.exe -L -o keeper.exe "${url}"; .\keeper.exe install --base ${ctx.origin} --logon`
        : `curl -L -o keeper "${url}" && chmod +x keeper && ./keeper install --base ${ctx.origin}`;
      return { build: row.stable, file: name, url, sha256: f.sha256, command };
    },

    async "builds.plan"(i: { os: string; arch?: string }, ctx) {
      const machine = ctx.who.addr.slice(1);
      const row = await fleetRow(ctx);
      const build = (JSON.parse(row.pins) as Record<string, number>)[machine] ?? row.stable;
      if (build == null) return null;
      const b = await db(ctx.env, ctx.fleet).first<Stored>("SELECT * FROM builds WHERE build = ?", build);
      if (!b) throw new Refusal("not_found", `сборки ${build} нет в каталоге`);
      const files = JSON.parse(b.files) as File[];
      const file = async (name: string) => {
        const f = files.find((x) => x.name === name);
        if (!f) throw new Refusal("not_found", `в сборке ${build} нет файла ${name}`);
        return { url: await link(ctx.env, "GET", fileKey(ctx.fleet, build, name)), sha256: f.sha256 };
      };
      return { build, host: await file(HOST_FILE), keeper: await file(keeperFile(i.os, i.arch)) };
    },
  },
};
