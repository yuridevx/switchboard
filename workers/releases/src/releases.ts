// Выпуски флота над базой D1 модуля: одна строка флота — stable частей, отличия планов машин и одна rev.
// Машины флота — пропуска роли host у gate; своего списка машин нет. Правка — UPDATE … WHERE rev = прочитанная:
// вторая одновременная не находит строку — conflict. Версии частей машины — архивы в R2 (готова та, у которой лежит
// .sha256), частей Cloudflare — версии Worker'а с меткой. edge — новейшая версия, не хранится. План машины уходит её
// keeper: ответом на releases.plan и кадром relay.deliver при перемене. Строки журнала — ledger.add по своей привязке.
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

/** Строка флота: stable часть → версия, отличия планов машина → часть → запись, rev. */
type Fleet = { stable: Record<string, string>; plans: Record<string, Record<string, PlanEntry>>; rev: number };

/** Кадр с to: ".releases" → reply тому, кто спросил. */
export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  return new Releases(env).frame(f);
}

class Releases {
  private env: Env;
  constructor(env: Env) {
    this.env = env;
  }

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
          // keeper спрашивает план POST пропуском своей машины
          if (kindOf(from) !== "machine") throw new Refusal("bad_frame", "план спрашивает только машина пропуском машины");
          return answer(ok(id, await this.planOf(await this.load(), machineOf(from)!)));
        }
        case "releases.list":
          return answer(ok(id, await this.list(typeof f.part === "string" ? f.part : undefined)));
        case "releases.upload":
          return answer(ok(id, await this.upload(f)));
        case "releases.deploy": {
          const r = await this.deploy(f, from);
          await this.deliver(r.plans);
          return answer(ok(id, r.result));
        }
        case "releases.set": {
          const r = await this.set(f);
          await this.deliver(r.plans);
          return answer(ok(id, r.result));
        }
      }
    } catch (e) {
      if (e instanceof Refusal) return refuse(e);
      if (e instanceof CfFailed) {
        log({ kind: "refuse", ev: f.type, word: "cf_failed", why: e.message, from, status: e.status, text: e.text });
        return answer(fail(id, "cf_failed"));
      }
      throw e;
    }
    return refuse(new Refusal("unknown_request", `releases не обслуживает ${f.type}`));
  }

  // ---------- хранилище ----------

  private async load(): Promise<Fleet> {
    const r = await this.env.DB.prepare("SELECT stable, plans, rev FROM fleet WHERE one = 1").first<{ stable: string; plans: string; rev: number }>();
    if (!r) throw new Error("в базе «Выпусков» нет строки флота — миграция не применена");
    return { stable: JSON.parse(r.stable), plans: JSON.parse(r.plans), rev: r.rev };
  }

  /** Запись строки флота с rev + 1 только поверх прочитанной: успела другая правка — conflict, строка не тронута. */
  private async save(next: Omit<Fleet, "rev">, read: number): Promise<number> {
    const r = await this.env.DB.prepare("UPDATE fleet SET stable = ?, plans = ?, rev = ? WHERE one = 1 AND rev = ?")
      .bind(JSON.stringify(next.stable), JSON.stringify(next.plans), read + 1, read)
      .run();
    if (!r.meta.changes) throw new Refusal("conflict", `строку флота уже правили после rev ${read} — повтори запрос`);
    return read + 1;
  }

  /** Машины флота — принятые пропуска роли host у gate. */
  private async machines(): Promise<string[]> {
    return (await this.env.GATE.list("host")).map((p) => p.name).sort();
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
  private async planOf(s: Fleet, m: string): Promise<Plan> {
    const stored = s.plans[m] ?? {};
    const parts: PlanPart[] = [];
    for (const p of new Set([...DEFAULT, ...Object.keys(stored)])) {
      const e = stored[p] ?? {};
      const version = e.pin ?? s.stable[p] ?? null;
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
    return { rev: s.rev, parts };
  }

  private async planFrame(s: Fleet, m: string): Promise<Frame> {
    return { type: "releases.plan", v: 1, to: `.keeper@${m}`, from: ".releases", ...(await this.planOf(s, m)) } as unknown as Frame;
  }

  /** Планы keeper'ам — привязкой relay.deliver в объект машины. relay не ответил — строка журнала, keeper возьмёт план на следующем соединении. */
  private async deliver(plans: Frame[]): Promise<void> {
    for (const f of plans) {
      try {
        const n = await this.env.RELAY.deliver(f);
        log({ kind: "note", ev: "releases.plan", why: `план → ${String(f.to)}: ${n ? "доставлен" : "keeper не на связи"}` });
      } catch (e) {
        log({ kind: "refuse", ev: "releases.plan", word: "offline", why: `relay.deliver → ${String(f.to)}: ${e}` });
      }
    }
  }

  /** Строка журнала флота по своей привязке; журнал не ответил — строка здесь. */
  private async journal(text: string, by: string): Promise<void> {
    const f: LedgerAdd = { type: "ledger.add", v: 1, to: ".ledger", ev: "part.deployed", text, ...(by ? { by } : {}) };
    try {
      await this.env.LEDGER.frame({ ...(f as unknown as Frame), from: ".releases" });
    } catch (e) {
      log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${text}: ${e}` });
    }
  }

  // ---------- запросы ----------

  private async list(part?: string): Promise<Listed> {
    const s = await this.load();
    const parts: Listed["parts"] = {};
    const cloud = Object.keys(this.env.CLOUD).filter((p) => !part || p === part);
    const machine = part ? (this.env.CLOUD[part] ? [] : [part]) : [...new Set([...(await this.machineParts()), ...Object.keys(s.stable)])].filter((p) => !this.env.CLOUD[p]);
    for (const p of machine.sort()) parts[p] = { where: "machine", edge: newest(await this.machineVersions(p)), stable: s.stable[p] ?? null };
    for (const p of cloud) {
      const vs = await versions(this.env, this.env.CLOUD[p]);
      const cur = await deployed(this.env, this.env.CLOUD[p]);
      parts[p] = { where: "cloud", edge: newest(vs.keys()), stable: [...vs].find(([, id]) => id === cur)?.[0] ?? null };
    }
    const machines: Listed["machines"] = (await this.machines()).map((m) => {
      const plan = s.plans[m] ?? {};
      return { machine: m, plan: part ? (plan[part] ? { [part]: plan[part] } : {}) : plan };
    });
    return { parts, machines, rev: s.rev };
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
  private async deploy(f: Frame, by: string): Promise<{ result: Deployed; plans: Frame[] }> {
    const part = f.part;
    if (typeof part !== "string" || (part !== "*" && !NAME.test(part))) throw new Refusal("bad_frame", "part — имя части или *");
    if (f.version !== undefined && (typeof f.version !== "string" || !VERSION.test(f.version))) throw new Refusal("bad_version", "версия — три числа");
    if (part === "*" && f.version !== undefined) throw new Refusal("bad_frame", "у * версии нет: каждая часть — на свою edge");
    const s = await this.load();
    // relay — последним: его выкладка рвёт соединения флота
    const cloudOrder = Object.keys(this.env.CLOUD).sort((a, b) => Number(a === "relay") - Number(b === "relay"));
    const targets = part === "*" ? [...DEFAULT, ...cloudOrder] : [part];
    const result: Deployed = { parts: {} };
    // stable частей машины пишется после цикла: отказ Cloudflare посреди «*» не оставляет stable без rev и планов
    const moved = new Map<string, string>();
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
        // выложенная часть Cloudflare — в журнал сразу: отказ дальше по циклу её не отменяет
        if (from !== to) await this.journal(`${p} ${from ?? "—"} → ${to}`, by);
      } else {
        const t = want ?? newest(await this.machineVersions(p));
        if (!t || !(await this.sha(p, t))) throw new Refusal("no_release", `у ${p} нет версии ${t ?? ""}`.trim());
        to = t;
        from = s.stable[p] ?? null;
        if (from !== to) moved.set(p, to);
      }
      result.parts[p] = { from, to };
    }
    const plans: Frame[] = [];
    if (moved.size) {
      const stable = { ...s.stable, ...Object.fromEntries(moved) };
      const rev = await this.save({ stable, plans: s.plans }, s.rev);
      for (const [p, to] of moved) await this.journal(`${p} ${s.stable[p] ?? "—"} → ${to}`, by);
      const next: Fleet = { stable, plans: s.plans, rev };
      // план меняется у машин, где часть идёт за stable: она в плане без pin или своя для каждой машины
      for (const m of await this.machines()) {
        const plan = s.plans[m] ?? {};
        if ([...moved.keys()].some((p) => (plan[p] ? !plan[p].pin : DEFAULT.includes(p)))) plans.push(await this.planFrame(next, m));
      }
    }
    return { result, plans };
  }

  /** Единственная правка плана машины. Уже так — ok с прежней rev. */
  private async set(f: Frame): Promise<{ result: SetResult; plans: Frame[] }> {
    const m = f.machine;
    const p = f.part;
    if (typeof m !== "string" || !NAME.test(m)) throw new Refusal("bad_frame", "machine — имя машины");
    if (typeof p !== "string" || !NAME.test(p) || this.env.CLOUD[p]) throw new Refusal("bad_frame", "part — имя части машины");
    if (p === "keeper" && (f.on !== undefined || f.force !== undefined || f.env !== undefined || f.remove !== undefined))
      throw new Refusal("bad_frame", "у keeper — только pin");
    const s = await this.load();
    const before = s.plans[m] ?? {};
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
      if (!e.pin && !s.stable[p]) throw new Refusal("no_release", `у ${p} нет stable — закрепи версию`);
      if (!Object.keys(e).length && DEFAULT.includes(p)) delete plan[p];
      else plan[p] = e;
    }
    if (JSON.stringify(plan) === JSON.stringify(before)) return { result: { machine: m, rev: s.rev }, plans: [] };
    const plans = { ...s.plans };
    if (Object.keys(plan).length) plans[m] = plan;
    else delete plans[m];
    const rev = await this.save({ stable: s.stable, plans }, s.rev);
    return { result: { machine: m, rev }, plans: [await this.planFrame({ stable: s.stable, plans, rev }, m)] };
  }
}
