// Выпуски флота: SQLite своего объекта — stable частей машины, планы машин и одна rev на все планы.
// Версии частей машины — архивы в R2 (готова та, у которой лежит .sha256), частей Cloudflare — версии Worker'а с меткой.
// edge — новейшая версия, не хранится. План машины уходит её keeper: ответом на releases.plan и кадром при перемене.
import { DurableObject } from "cloudflare:workers";
import { accepts, fail, kindOf, machineOf, ok, type Frame } from "@switchboard/protocol";
import type { LedgerAdd } from "@switchboard/ledger";
import { CONTRACT, type Deployed, type Listed, type Plan, type PlanEntry, type PlanPart, type SetResult, type Upload } from "../contract.ts";
import { CfFailed, deploy, deployed, versions } from "./cf.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { parseSha, presign, RELEASES_BUCKET, shaKey, tgzKey, VERSION_RE as VERSION } from "@switchboard/release";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** части каждой машины: без записи в плане — за stable; они же — части машины из сборки для deploy * */
const DEFAULT = ["keeper", "host"];

/** Порядок номеров: 1.1.10 новее 1.1.9. */
export function cmp(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
const newest = (vs: Iterable<string>): string | null => [...vs].filter((v) => VERSION.test(v)).sort(cmp).pop() ?? null;

/** Отказ словом и причина для журнала. */
class Refusal {
  word: string;
  why: string;
  constructor(word: string, why: string) {
    this.word = word;
    this.why = why;
  }
}

export class Releases extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS stable (part TEXT PRIMARY KEY, version TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS plans (machine TEXT PRIMARY KEY, plan TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  /** Кадр с to: ".releases" → reply тому, кто спросил; планы keeper'ам и ledger.add — следом. */
  async frame(f: Frame): Promise<Frame[]> {
    const from = f.from ?? "";
    const answer = (r: Frame): Frame[] => (f.id ? [{ ...r, to: from }] : []);
    const refuse = (r: Refusal): Frame[] => {
      log({ kind: "refuse", ev: f.type, word: r.word, why: r.why, from });
      return f.id ? answer(fail(f.id, r.word)) : [];
    };

    if (f.type === "reply") {
      log({ kind: "note", ev: "reply", from, why: "releases ответов не ждёт" });
      return [];
    }
    const bad = accepts(f, CONTRACT);
    if (bad) return refuse(new Refusal(bad.word, bad.why));
    if (!f.id) return refuse(new Refusal("bad_frame", `${f.type} без id — ответить некому`));
    const id = f.id;

    try {
      switch (f.type) {
        case "releases.plan": {
          if (kindOf(from) !== "part" || !from.startsWith(".keeper@")) throw new Refusal("bad_frame", "план спрашивает только keeper машины");
          const m = machineOf(from)!;
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO plans (machine, plan) VALUES (?, '{}')", m);
          return answer(ok(id, await this.planOf(m)));
        }
        case "releases.list":
          return answer(ok(id, await this.list(typeof f.part === "string" ? f.part : undefined)));
        case "releases.upload":
          return answer(ok(id, await this.upload(f)));
        case "releases.deploy": {
          const r = await this.deploy(f, from);
          return [...answer(ok(id, r.result)), ...r.out];
        }
        case "releases.set": {
          const r = await this.set(f);
          return [...answer(ok(id, r.result)), ...r.out];
        }
      }
    } catch (e) {
      // отказ посреди «*»: уже выложенные части Cloudflare — в журнал флота
      const done = (e as { done?: Frame[] }).done ?? [];
      if (e instanceof Refusal) return [...refuse(e), ...done];
      if (e instanceof CfFailed) {
        log({ kind: "refuse", ev: f.type, word: "cf_failed", why: e.message, from, status: e.status, text: e.text });
        return [...answer(fail(id, "cf_failed")), ...done];
      }
      throw e;
    }
    return refuse(new Refusal("unknown_request", `releases не обслуживает ${f.type}`));
  }

  // ---------- хранилище ----------

  private get rev(): number {
    const r = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'rev'").toArray()[0];
    return r ? Number(r.v) : 0;
  }

  private bump(): number {
    const rev = this.rev + 1;
    this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('rev', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(rev));
    return rev;
  }

  private stableOf(part: string): string | null {
    return this.ctx.storage.sql.exec<{ version: string }>("SELECT version FROM stable WHERE part = ?", part).toArray()[0]?.version ?? null;
  }

  private plans(): Map<string, Record<string, PlanEntry>> {
    const out = new Map<string, Record<string, PlanEntry>>();
    for (const r of this.ctx.storage.sql.exec<{ machine: string; plan: string }>("SELECT machine, plan FROM plans ORDER BY machine")) out.set(r.machine, JSON.parse(r.plan));
    return out;
  }

  private entries(m: string): Record<string, PlanEntry> {
    const r = this.ctx.storage.sql.exec<{ plan: string }>("SELECT plan FROM plans WHERE machine = ?", m).toArray()[0];
    return r ? JSON.parse(r.plan) : {};
  }

  // ---------- R2 ----------

  /** Хэш готовой версии части машины: .sha256 лежит — версия загружена целиком. */
  private async sha(part: string, version: string): Promise<string | null> {
    const o = await this.env.BUCKET.get(shaKey(part, version));
    return o ? parseSha(await o.text()) : null;
  }

  /** Готовые версии части машины. */
  private async machineVersions(part: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.env.BUCKET.list({ prefix: `${part}/`, cursor });
      for (const o of r.objects) {
        const v = o.key.slice(part.length + 1).replace(/\.sha256$/, "");
        if (o.key === shaKey(part, v) && VERSION.test(v)) out.push(v);
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return out.sort(cmp);
  }

  /** Части машины, у которых есть архивы. */
  private async machineParts(): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.env.BUCKET.list({ delimiter: "/", cursor });
      for (const p of r.delimitedPrefixes) out.push(p.replace(/\/$/, ""));
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return out;
  }

  private link(method: "GET" | "PUT", key: string): Promise<string> {
    return presign(
      { accessKeyId: this.env.R2_LINK_KEY_ID, secretAccessKey: this.env.R2_LINK_SECRET },
      { method, host: `${this.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${RELEASES_BUCKET}/${key}`, now: new Date() },
    );
  }

  // ---------- план ----------

  /** План машины для keeper: stable раскрыт в версии, ссылки на архивы на час. Версии без хэша в план не идут. */
  private async planOf(m: string): Promise<Plan> {
    const stored = this.entries(m);
    const parts: PlanPart[] = [];
    for (const p of new Set([...DEFAULT, ...Object.keys(stored)])) {
      const e = stored[p] ?? {};
      const version = e.pin ?? this.stableOf(p);
      if (!version) continue;
      const sha256 = await this.sha(p, version);
      if (!sha256) {
        log({ kind: "stop", ev: "releases.plan", why: `у ${p} ${version} нет хэша в R2 — часть не в плане`, machine: m });
        continue;
      }
      const pp: PlanPart = { part: p, version, sha256, url: await this.link("GET", tgzKey(p, version)) };
      if (e.on !== undefined) pp.on = e.on;
      if (e.force) pp.force = true;
      if (e.env) pp.env = e.env;
      parts.push(pp);
    }
    return { rev: this.rev, parts };
  }

  private async planFrame(m: string): Promise<Frame> {
    return { type: "releases.plan", v: 1, to: `.keeper@${m}`, ...(await this.planOf(m)) } as unknown as Frame;
  }

  // ---------- запросы ----------

  private async list(part?: string): Promise<Listed> {
    const parts: Listed["parts"] = {};
    const cloud = Object.keys(this.env.CLOUD).filter((p) => !part || p === part);
    const stored = this.ctx.storage.sql.exec<{ part: string }>("SELECT part FROM stable").toArray().map((r) => r.part);
    const machine = part ? (this.env.CLOUD[part] ? [] : [part]) : [...new Set([...(await this.machineParts()), ...stored])].filter((p) => !this.env.CLOUD[p]);
    for (const p of machine.sort()) parts[p] = { where: "machine", edge: newest(await this.machineVersions(p)), stable: this.stableOf(p) };
    for (const p of cloud) {
      const vs = await versions(this.env, this.env.CLOUD[p]);
      const cur = await deployed(this.env, this.env.CLOUD[p]);
      parts[p] = { where: "cloud", edge: newest(vs.keys()), stable: [...vs].find(([, id]) => id === cur)?.[0] ?? null };
    }
    const machines: Listed["machines"] = [];
    for (const [machine, plan] of this.plans()) machines.push({ machine, plan: part ? (plan[part] ? { [part]: plan[part] } : {}) : plan });
    return { parts, machines, rev: this.rev };
  }

  private async upload(f: Frame): Promise<Upload> {
    const part = f.part;
    const version = f.version;
    if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя части");
    if (this.env.CLOUD[part]) throw new Refusal("bad_frame", `${part} — часть Cloudflare: её версии загружает wrangler`);
    if (typeof version !== "string" || !VERSION.test(version)) throw new Refusal("bad_version", "версия — три числа");
    if ((await this.env.BUCKET.head(tgzKey(part, version))) || (await this.env.BUCKET.head(shaKey(part, version))))
      throw new Refusal("version_exists", `${part} ${version} уже загружена — версия загружается один раз`);
    return { tgz: await this.link("PUT", tgzKey(part, version)), sha256: await this.link("PUT", shaKey(part, version)) };
  }

  /** stable частей на версию: машины — у себя и планы keeper'ам, Cloudflare — выкладкой версии. */
  private async deploy(f: Frame, by: string): Promise<{ result: Deployed; out: Frame[] }> {
    const part = f.part;
    if (typeof part !== "string" || (part !== "*" && !NAME.test(part))) throw new Refusal("bad_frame", "part — имя части или *");
    if (f.version !== undefined && (typeof f.version !== "string" || !VERSION.test(f.version))) throw new Refusal("bad_version", "версия — три числа");
    if (part === "*" && f.version !== undefined) throw new Refusal("bad_frame", "у * версии нет: каждая часть — на свою edge");
    // relay — последним: его выкладка рвёт соединения флота
    const cloudOrder = Object.keys(this.env.CLOUD).sort((a, b) => Number(a === "relay") - Number(b === "relay"));
    const targets = part === "*" ? [...DEFAULT, ...cloudOrder] : [part];
    const result: Deployed = { parts: {} };
    const out: Frame[] = [];
    // stable частей машины пишется после цикла: отказ Cloudflare посреди «*» не оставляет stable без rev и планов
    const moved = new Map<string, string>();
    // записи о выложенных частях Cloudflare: при отказе посреди цикла они уходят с отказом
    const done: Frame[] = [];
    try {
      for (const p of targets) {
        const want = part === "*" ? undefined : (f.version as string | undefined);
        let from: string | null;
        let to: string;
        const script = this.env.CLOUD[p];
        if (script) {
          const vs = await versions(this.env, script);
          const t = want ?? newest(vs.keys());
          if (!t || !vs.has(t)) throw new Refusal("no_release", `у ${p} нет версии ${t ?? "с меткой"}`);
          to = t;
          const cur = await deployed(this.env, script);
          from = [...vs].find(([, id]) => id === cur)?.[0] ?? null;
          if (cur !== vs.get(to)) await deploy(this.env, script, vs.get(to)!);
        } else {
          const t = want ?? newest(await this.machineVersions(p));
          if (!t || !(await this.sha(p, t))) throw new Refusal("no_release", `у ${p} нет версии ${t ?? ""}`.trim());
          to = t;
          from = this.stableOf(p);
          if (from !== to) moved.set(p, to);
        }
        result.parts[p] = { from, to };
        if (from !== to) {
          const rec = ledger(`${p} ${from ?? "—"} → ${to}`, by);
          out.push(rec);
          if (script) done.push(rec);
        }
      }
    } catch (e) {
      if (e instanceof Refusal || e instanceof CfFailed) Object.assign(e, { done });
      throw e;
    }
    if (moved.size) {
      for (const [p, to] of moved) this.ctx.storage.sql.exec("INSERT INTO stable (part, version) VALUES (?, ?) ON CONFLICT(part) DO UPDATE SET version = excluded.version", p, to);
      this.bump();
      // план меняется у машин, где часть идёт за stable: она в плане без pin или своя для каждой машины
      for (const [m, plan] of this.plans())
        if ([...moved.keys()].some((p) => (plan[p] ? !plan[p].pin : DEFAULT.includes(p)))) out.push(await this.planFrame(m));
    }
    return { result, out };
  }

  /** Единственная правка плана машины. Уже так — ok с прежней rev. */
  private async set(f: Frame): Promise<{ result: SetResult; out: Frame[] }> {
    const m = f.machine;
    const p = f.part;
    if (typeof m !== "string" || !NAME.test(m)) throw new Refusal("bad_frame", "machine — имя машины");
    if (typeof p !== "string" || !NAME.test(p) || this.env.CLOUD[p]) throw new Refusal("bad_frame", "part — имя части машины");
    if (p === "keeper" && (f.on !== undefined || f.force !== undefined || f.env !== undefined || f.remove !== undefined))
      throw new Refusal("bad_frame", "у keeper — только pin");
    const before = this.entries(m);
    const plan: Record<string, PlanEntry> = structuredClone(before);
    if (f.remove === true) {
      if (!plan[p]) throw new Refusal("no_part", `${p} нет в плане ${m}`);
      delete plan[p];
    } else {
      const e: PlanEntry = { ...(plan[p] ?? {}) };
      if (f.pin === null) delete e.pin;
      else if (f.pin !== undefined) {
        if (typeof f.pin !== "string" || !VERSION.test(f.pin)) throw new Refusal("bad_version", "pin — три числа или null");
        if (!(await this.sha(p, f.pin))) throw new Refusal("no_release", `у ${p} нет версии ${f.pin}`);
        e.pin = f.pin;
      }
      if (typeof f.on === "boolean") e.on = f.on;
      if (f.force === true) e.force = true;
      if (f.force === false) delete e.force;
      if (f.env !== undefined) {
        if (!f.env || typeof f.env !== "object" || Object.values(f.env).some((x) => typeof x !== "string")) throw new Refusal("bad_frame", "env — строки");
        if (Object.keys(f.env).length) e.env = f.env as Record<string, string>;
        else delete e.env;
      }
      // включено — по умолчанию; force — только у выключенной
      if (e.on === true) delete e.on;
      if (e.on !== false) delete e.force;
      if (!e.pin && !this.stableOf(p)) throw new Refusal("no_release", `у ${p} нет stable — закрепи версию`);
      if (!Object.keys(e).length && DEFAULT.includes(p)) delete plan[p];
      else plan[p] = e;
    }
    const known = this.ctx.storage.sql.exec("SELECT 1 FROM plans WHERE machine = ?", m).toArray().length > 0;
    if (known && JSON.stringify(plan) === JSON.stringify(before)) return { result: { machine: m, rev: this.rev }, out: [] };
    this.ctx.storage.sql.exec("INSERT INTO plans (machine, plan) VALUES (?, ?) ON CONFLICT(machine) DO UPDATE SET plan = excluded.plan", m, JSON.stringify(plan));
    const rev = this.bump();
    return { result: { machine: m, rev }, out: [await this.planFrame(m)] };
  }
}

function ledger(text: string, by: string): Frame {
  const f: LedgerAdd = { type: "ledger.add", v: 1, to: ".ledger", ev: "part.deployed", text, ...(by ? { by } : {}) };
  return f as unknown as Frame;
}
