// Выпуски флота над базой D1 модуля: одна строка флота — stable частей, отличия планов машин и одна rev.
// Машины флота — пропуска роли host у gate; своего списка машин нет. Правка — UPDATE … WHERE rev = прочитанная:
// вторая одновременная не находит строку — conflict. Версии частей машины — архивы в R2 (готова та, у которой лежит
// .sha256), частей Cloudflare — версии Worker'а с меткой. edge — новейшая версия, не хранится. План машины уходит её
// keeper: ответом на releases.plan и кадром relay.deliver при перемене. Строки журнала — ledger.add по своей привязке.
// Вид части — из каталога, по module.json в начале новейшего архива: workers — часть Cloudflare, имя Worker'а — по
// флоту из настройки FLEET; тип os, корень сборки (ядро Host) или архив без манифеста — часть машины; остальные модули
// входят в сборки и частями не бывают.
// Сборка приложения — корень и модули, чей into его называет: <флот>/<приложение>/<корень>+<n>.tgz, внутри build.json —
// список в порядке зависимостей. Выкладка модуля — новая сборка: текущий список + модуль, проверка набора флота
// (check: модули всех сборок, Worker'ы, приложения ОС, библиотеки). Host — stable и планы машин; страница (пульт,
// телефон) — версия её Worker'а со статикой сборки, метка — номер сборки, и выкладка. Номер с «+» — сборка.
import { accepts, fail, kindOf, machineOf, ok, within, type Frame } from "@switchboard/protocol";
import type { LedgerAdd } from "@switchboard/ledger";
import { CONTRACT, type Deployed, type Fetched, type Listed, type Plan, type PlanEntry, type PlanPart, type SetResult, type Upload } from "../contract.ts";
import { CfFailed, deploy, deployed, publishStatic, urlsOf, versions } from "./cf.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { BUILD_FILE, buildFile, entries, manifestOf, pack, parseSha, presign, RELEASES_BUCKET, sha256hex, shaKey, shaLine, tgzKey, webBuild, type BuildList } from "@switchboard/release";
import { check, order, ownerOf, type Manifest } from "@switchboard/manifest-gate";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Номер: версия каталога — три числа, сборка — ещё «+n». */
const VERSION = /^\d+\.\d+\.\d+(\+\d+)?$/;
const isBuild = (v: string) => v.includes("+");
/** части каждой машины: без записи в плане — за stable; они же — части машины из сборки для deploy * */
const DEFAULT = ["keeper", "host"];

/** Порядок номеров: 1.1.10 новее 1.1.9, 1.2.0+10 новее 1.2.0+9. */
export function cmp(a: string, b: string): number {
  const x = a.split(/[.+]/).map(Number);
  const y = b.split(/[.+]/).map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
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

/** Вид части: Cloudflare — с именем Worker'а этого флота, или машины; app — корень сборки. */
type Kind = { where: "cloud"; script: string; app: boolean } | { where: "machine"; app: boolean };

/** Модуль каталога: готовые версии и манифест новейшей. */
type Entry = { versions: string[]; manifest: CatManifest | null };
type CatManifest = Manifest & { into?: string[]; workers?: Record<string, string> };


/** Начало архива, которого хватает на module.json. */
const HEAD = 64 * 1024;

/** Строка флота: stable часть → версия, отличия планов машина → часть → запись, rev. */
type Fleet = { stable: Record<string, string>; plans: Record<string, Record<string, PlanEntry>>; rev: number };

/** Поле кадра со списком имён; нет поля — пусто. */
function namesOf(x: unknown, field: string): string[] {
  if (x === undefined) return [];
  if (!Array.isArray(x) || x.some((n) => typeof n !== "string" || !NAME.test(n))) throw new Refusal("bad_frame", `${field} — список имён`);
  return x as string[];
}

/** Кадр с to: ".releases" → reply тому, кто спросил. */
export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  return new Releases(env).frame(f);
}

class Releases {
  private env: Env;
  /** каталог — читается один раз на запрос */
  private cat?: Promise<Map<string, Entry>>;
  constructor(env: Env) {
    this.env = env;
  }

  async frame(f: Frame): Promise<Frame[]> {
    const from = f.from ?? "";
    const answer = (r: Frame): Frame[] => (f.id ? [{ ...r, to: from }] : []);
    const refuse = (r: Refusal): Frame[] => {
      log({ kind: "refuse", ev: f.type, word: r.word, why: r.why, from });
      return f.id ? answer({ ...fail(f.id, r.word), why: r.why }) : [];
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
        case "releases.fetch":
          return answer(ok(id, await this.fetchLink(f)));
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
        return answer({ ...fail(id, "cf_failed"), why: e.message });
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
    return (await within(this.env.GATE.list("host"), "gate не ответил на list")).map((p) => p.name).sort();
  }

  // ---------- R2 ----------

  /** Ключ архива: сборка — <флот>/<приложение>/<номер>, версия каталога — <модуль>/<номер>. */
  private tgz(part: string, v: string): string {
    return isBuild(v) ? `${this.env.FLEET}/${tgzKey(part, v)}` : tgzKey(part, v);
  }
  private shaOf(part: string, v: string): string {
    return isBuild(v) ? `${this.env.FLEET}/${shaKey(part, v)}` : shaKey(part, v);
  }

  /** Хэш готовой версии: .sha256 лежит — версия загружена целиком. */
  private async sha(part: string, version: string): Promise<string | null> {
    const o = await this.env.BUCKET.get(this.shaOf(part, version));
    return o ? parseSha(await o.text()) : null;
  }

  /** Готовые версии части машины: у корня сборки — сборки этого флота, у остальных — версии каталога. */
  private async machineVersions(part: string): Promise<string[]> {
    return this.readyUnder((await this.partKinds()).get(part)?.app ? `${this.env.FLEET}/${part}/` : `${part}/`);
  }

  /** Готовые версии под папкой R2: рядом лежит .sha256. */
  private async readyUnder(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.env.BUCKET.list({ prefix, cursor });
      for (const o of r.objects) {
        const v = o.key.slice(prefix.length).replace(/\.sha256$/, "");
        if (o.key === prefix + `${v}.sha256` && VERSION.test(v)) out.push(v);
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return out.sort(cmp);
  }

  /** Каталог: модуль → готовые версии и module.json новейшей (сборки флотов — не каталог). */
  private catalog(): Promise<Map<string, Entry>> {
    this.cat ??= (async () => {
      const ready = new Map<string, string[]>();
      let cursor: string | undefined;
      do {
        const r = await this.env.BUCKET.list({ cursor });
        for (const o of r.objects) {
          const i = o.key.indexOf("/");
          const p = o.key.slice(0, i);
          const v = o.key.slice(i + 1).replace(/\.sha256$/, "");
          if (o.key === shaKey(p, v) && VERSION.test(v) && !isBuild(v)) ready.set(p, [...(ready.get(p) ?? []), v]);
        }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      const out = new Map<string, Entry>();
      await Promise.all(
        [...ready].map(async ([p, vs]) => {
          vs.sort(cmp);
          out.set(p, { versions: vs, manifest: await this.manifest(p, vs[vs.length - 1]) });
        }),
      );
      return out;
    })();
    return this.cat;
  }

  /** module.json версии каталога — по началу архива; архив без манифеста — null. */
  private async manifest(p: string, v: string): Promise<CatManifest | null> {
    const o = await this.env.BUCKET.get(tgzKey(p, v), { range: { offset: 0, length: HEAD } });
    return o ? ((await manifestOf(new Uint8Array(await o.arrayBuffer()))) as CatManifest | null) : null;
  }

  /** Части и их вид по манифесту новейшей версии. */
  private async partKinds(): Promise<Map<string, Kind>> {
    const out = new Map<string, Kind>();
    for (const [p, { manifest: m }] of await this.catalog()) {
      const k = this.kindBy(m);
      if (k) out.set(p, k);
    }
    return out;
  }

  /** Вид части по манифесту её новейшей версии; модуль сборки частью не бывает — null. */
  private kindBy(m: CatManifest | null): Kind | null {
    const script = m?.workers?.[this.env.FLEET];
    if (script) return { where: "cloud", script, app: m?.type === "web-app" };
    return !m || m.type === "os" || m.type === "sdk-core" ? { where: "machine", app: m?.type === "sdk-core" } : null;
  }

  /** Архив целиком: записи с данными. */
  private async files(key: string): Promise<Array<{ path: string; data: Buffer }>> {
    const o = await this.env.BUCKET.get(key);
    if (!o) throw new Refusal("no_release", `в R2 нет ${key}`);
    return entries(Buffer.from(await o.arrayBuffer())).filter((e) => e.data) as Array<{ path: string; data: Buffer }>;
  }

  /** Имя Worker'а части Cloudflare этого флота; часть машины или не часть — null. */
  private async script(part: string): Promise<string | null> {
    const k = (await this.partKinds()).get(part);
    return k?.where === "cloud" ? k.script : null;
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
      const pp: PlanPart = { part: p, version, sha256, url: await this.link("GET", this.tgz(p, version)) };
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
        const n = await within(this.env.RELAY.deliver(f), "relay не ответил на deliver");
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
      await within(this.env.LEDGER.frame({ ...(f as unknown as Frame), from: ".releases" }), "журнал не ответил");
    } catch (e) {
      log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${text}: ${e}` });
    }
  }

  // ---------- запросы ----------

  private async list(part?: string): Promise<Listed> {
    const s = await this.load();
    const last = (vs: Iterable<string>) => [...vs].filter((v) => VERSION.test(v)).sort(cmp).slice(-10);
    const onMachine = (p: string, vs: string[]): Listed["parts"][string] => ({ where: "machine", edge: newest(vs), stable: s.stable[p] ?? null, versions: last(vs) });
    // Worker'ы спрашиваются у API Cloudflare: метки версий и выложенная
    const inCloud = async (p: string, k: Kind & { where: "cloud" }): Promise<Listed["parts"][string]> => {
      const [vs, cur] = await Promise.all([versions(this.env, k.script), deployed(this.env, k.script)]);
      const own = k.app ? await this.readyUnder(`${this.env.FLEET}/${p}/`) : [...vs.keys()];
      return { where: "cloud", edge: newest(own), stable: [...vs].find(([, id]) => id === cur)?.[0] ?? null, versions: last(own) };
    };
    const planned = (names: string[]): Listed["machines"] =>
      names.map((m) => {
        const plan = s.plans[m] ?? {};
        return { machine: m, plan: part ? (plan[part] ? { [part]: plan[part] } : {}) : plan };
      });
    if (part) {
      // одна часть — только её папка и манифест новейшей версии: каталог целиком не обходится
      const own = await this.readyUnder(`${part}/`);
      const top = newest(own.filter((v) => !isBuild(v)));
      const k = top ? this.kindBy(await this.manifest(part, top)) : null;
      const [line, names] = await Promise.all([
        k?.where === "cloud" ? inCloud(part, k) : k?.app ? this.readyUnder(`${this.env.FLEET}/${part}/`).then((vs) => onMachine(part, vs)) : onMachine(part, own),
        this.machines(),
      ]);
      return { parts: { [part]: line }, machines: planned(names), rev: s.rev };
    }
    const kinds = await this.partKinds();
    const cloud = [...kinds].filter(([, k]) => k.where === "cloud").map(([p]) => p).sort();
    const machine = [...new Set([...kinds.keys(), ...Object.keys(s.stable)])].filter((p) => kinds.get(p)?.where !== "cloud" && (kinds.has(p) || s.stable[p])).sort();
    const [onMachines, inClouds, names] = await Promise.all([
      Promise.all(machine.map(async (p) => [p, onMachine(p, await this.machineVersions(p))] as const)),
      Promise.all(cloud.map(async (p) => [p, await inCloud(p, kinds.get(p) as Kind & { where: "cloud" })] as const)),
      this.machines(),
    ]);
    const parts: Listed["parts"] = Object.fromEntries([...onMachines, ...inClouds]);
    // модули сборок: номер в выложенной сборке каждого приложения — из её списка, новейший — из каталога
    const cat = await this.catalog();
    const modules: NonNullable<Listed["modules"]> = {};
    for (const [n, e] of cat) if (e.manifest?.into?.length) modules[n] = { into: e.manifest.into, built: {}, edge: e.versions.at(-1) ?? null };
    const builds = await Promise.all(
      [...kinds]
        .filter(([, k]) => k.app)
        .map(async ([app]) => {
          const cur = parts[app]?.stable ?? (await this.current(app, s));
          return [app, cur ? await this.listOf(app, cur) : new Map<string, string>()] as const;
        }),
    );
    for (const [app, list] of builds) for (const [n, v] of list) if (modules[n]) modules[n].built[app] = v;
    return { parts, machines: planned(names), rev: s.rev, modules };
  }

  /**
   * Ссылки на запись версии. Версия занята, когда лежит её .sha256: с тем же хэшем (sha256 в кадре) — same, загружать
   * нечего; с другим — version_exists. Архив без хэша — версия не готова (загрузка оборвалась): ссылки даются снова.
   */
  /** Ссылка на чтение архива версии каталога на час; без version — новейшая готовая. Сборки — не каталог. */
  private async fetchLink(f: Frame): Promise<Fetched> {
    const part = f.part;
    if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя модуля");
    if (f.version !== undefined && (typeof f.version !== "string" || !VERSION.test(f.version) || isBuild(f.version)))
      throw new Refusal("bad_version", "версия каталога — три числа, без «+»");
    const version = (f.version as string | undefined) ?? (await this.catalog()).get(part)?.versions.at(-1);
    if (!version || !(await this.sha(part, version))) throw new Refusal("no_release", `у ${part} нет версии ${version ?? "в каталоге"}`);
    return { version, url: await this.link("GET", tgzKey(part, version)) };
  }

  private async upload(f: Frame): Promise<Upload> {
    const part = f.part;
    const version = f.version;
    if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя части");
    if (typeof version !== "string" || !VERSION.test(version)) throw new Refusal("bad_version", "версия — три числа");
    if (f.sha256 !== undefined && (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))) throw new Refusal("bad_frame", "sha256 — хэш архива, 64 знака hex");
    const had = await this.sha(part, version);
    if (had && had === f.sha256) return { same: true };
    if (had) throw new Refusal("version_exists", `${part} ${version} уже загружена с другим хэшем — подними номер`);
    return { tgz: await this.link("PUT", tgzKey(part, version)), sha256: await this.link("PUT", shaKey(part, version)) };
  }

  /** stable частей на версию: машины — у себя и планы keeper'ам, Cloudflare — выкладкой версии; модуль сборки — новой сборкой. */
  private async deploy(f: Frame, by: string): Promise<{ result: Deployed; plans: Frame[] }> {
    const part = f.part;
    if (typeof part !== "string" || (part !== "*" && !NAME.test(part))) throw new Refusal("bad_frame", "part — имя части или *");
    if (f.version !== undefined && f.version !== null && (typeof f.version !== "string" || !VERSION.test(f.version))) throw new Refusal("bad_version", "версия — три числа, сборка «+n» или null — снять модуль");
    if (part === "*" && f.version !== undefined) throw new Refusal("bad_frame", "у * версии нет: каждая часть — на свою edge");
    const want = (f.version ?? undefined) as string | undefined;
    const also = { without: namesOf(f.without, "without"), checkWith: namesOf(f.check_with, "check_with") };
    if (also.without.length + also.checkWith.length && f.latest !== true) throw new Refusal("bad_frame", "without и check_with — только вместе с latest: true");
    const kind = part === "*" ? undefined : (await this.partKinds()).get(part);
    const cat = part === "*" ? undefined : (await this.catalog()).get(part);
    // latest: корень и все его модули — на новейшие версии каталога одной сборкой: смена, которую нельзя выложить по модулю
    if (f.latest !== undefined) {
      // у модуля — все приложения его into сразу, одной проверкой: смену контракта, общего для приложений, порознь не выложить
      const apps = kind?.app ? [part as string] : (cat?.manifest?.into ?? []);
      if (f.latest !== true || want !== undefined || !apps.length) throw new Refusal("bad_frame", "latest: true — только у корня сборки или модуля сборки и без version");
      return this.rebuild(apps, { name: part as string, version: cat!.versions[cat!.versions.length - 1] }, by, true, also);
    }
    // модуль сборки: новая сборка каждого приложения из его into; version: null — сборки без него
    if (part !== "*" && !kind && cat?.manifest?.into?.length) {
      if (want && isBuild(want)) throw new Refusal("bad_version", `${part} — модуль: версия каталога, без «+»`);
      return this.rebuild(cat.manifest.into, { name: part, version: f.version === null ? null : (want ?? cat.versions[cat.versions.length - 1]) }, by);
    }
    if (f.version === null) throw new Refusal("bad_frame", `${part} — не модуль сборки: снимать нечего`);
    // корень сборки: версия ядра в каталоге — сборка с этим ядром; сборка «+n» или прежний архив без манифеста — откат на него
    if (kind?.app && !(want && (isBuild(want) || !(await this.manifest(part, want))))) {
      return this.rebuild([part], { name: part, version: want ?? cat!.versions[cat!.versions.length - 1] }, by);
    }
    const s = await this.load();
    // relay — последним: его выкладка рвёт соединения флота
    const cloudOrder = [...(await this.partKinds())]
      .filter(([, k]) => k.where === "cloud" && !k.app)
      .map(([p]) => p)
      .sort((a, b) => Number(a === "relay") - Number(b === "relay") || (a < b ? -1 : 1));
    const targets = part === "*" ? [...DEFAULT, ...cloudOrder] : [part];
    const result: Deployed = { parts: {} };
    // stable частей машины пишется после цикла: отказ Cloudflare посреди «*» не оставляет stable без rev и планов
    const moved = new Map<string, string>();
    for (const p of targets) {
      const want = part === "*" ? undefined : (f.version as string | undefined);
      let from: string | null;
      let to: string;
      const script = await this.script(p);
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

  /** Номер текущей сборки приложения: Host — stable флота, страница — метка выложенной версии её Worker'а. */
  private async current(app: string, s: Fleet): Promise<string | null> {
    const k = (await this.partKinds()).get(app);
    if (k?.where !== "cloud") return s.stable[app] ?? null;
    const [vs, cur] = await Promise.all([versions(this.env, k.script), deployed(this.env, k.script)]);
    return [...vs].find(([, id]) => id === cur)?.[0] ?? null;
  }

  /** Список приложения: из его сборки, а до первой сборки — корень и все модули каталога с into приложения, новейшие. */
  private async listOf(app: string, cur: string | null): Promise<Map<string, string>> {
    const cat = await this.catalog();
    const list = new Map<string, string>();
    if (cur && isBuild(cur)) {
      const b = JSON.parse((await this.files(this.tgz(app, cur))).find((x) => x.path === BUILD_FILE)!.data.toString("utf8")) as BuildList;
      list.set(app, b.version.split("+")[0]);
      for (const m of b.modules) list.set(m.name, m.version);
    } else {
      list.set(app, cat.get(app)!.versions.at(-1)!);
      for (const [n, e] of cat) if (e.manifest?.into?.includes(app)) list.set(n, e.versions.at(-1)!);
    }
    return list;
  }

  /** Список приложения на новейших номерах: набор выложенной сборки и модули приложения, от которых он теперь зависит. Чужие модули каталога с into не входят. */
  private async latestOf(app: string, cur: string | null, cat: Awaited<ReturnType<Releases["catalog"]>>, without: string[]): Promise<Map<string, string>> {
    const list = await this.listOf(app, cur);
    for (const n of without) list.delete(n);
    const newest = (n: string) => cat.get(n)?.versions.at(-1);
    for (const n of list.keys()) list.set(n, newest(n) ?? list.get(n)!);
    for (let queue = [...list.keys()]; queue.length; ) {
      const n = queue.pop()!;
      for (const ref of Object.keys((await this.manifest(n, list.get(n)!))?.uses ?? {})) {
        const owner = ownerOf(ref);
        if (list.has(owner) || without.includes(owner) || !cat.get(owner)?.manifest?.into?.includes(app)) continue;
        list.set(owner, newest(owner)!);
        queue.push(owner);
      }
    }
    return list;
  }

  /** Манифесты списка по версиям каталога — разом. */
  private async manifests(list: Map<string, string>): Promise<Map<string, CatManifest>> {
    const got = await Promise.all(
      [...list].map(async ([n, v]) => {
        const m = await this.manifest(n, v);
        if (!m) throw new Refusal("check_failed", `у ${n} ${v} нет module.json в начале архива`);
        return [n, m] as const;
      }),
    );
    return new Map(got);
  }

  /**
   * Новые сборки приложений apps: текущий список с заменой change, проверка набора флота — новые сборки, текущие
   * сборки остальных приложений, Worker'ы, приложения ОС и библиотеки каталога. Host — архив под именем флота, stable
   * и планы машин; страница — тот же архив и версия её Worker'а со статикой, выложенная. without — модули, которых
   * больше нет в собираемых сборках; checkWith — приложения, которые проверяются на новейших списках, но не собираются:
   * смена границы модулей выкладывается по частям, а проверяется как один набор.
   */
  private async rebuild(
    apps: string[],
    change: { name: string; version: string | null },
    by: string,
    latest = false,
    { without, checkWith }: { without: string[]; checkWith: string[] } = { without: [], checkWith: [] },
  ): Promise<{ result: Deployed; plans: Frame[] }> {
    const s = await this.load();
    const cat = await this.catalog();
    const kinds = await this.partKinds();
    if (change.version !== null && (!(await this.sha(change.name, change.version)) || !cat.has(change.name))) throw new Refusal("no_release", `у ${change.name} нет версии ${change.version}`);
    // списки всех приложений флота: собираемые — с заменой, остальные — как выложены
    const roots = [...kinds].filter(([, k]) => k.app).map(([p]) => p);
    for (const app of [...apps, ...checkWith]) if (!roots.includes(app)) throw new Refusal("no_build", `${app} не собирается «Выпусками»: в каталоге нет его корня сборки`);
    if (without.includes(change.name) || without.some((n) => roots.includes(n))) throw new Refusal("bad_frame", "without — модули сборки, не корень и не выкладываемая часть");
    const checked = [...apps, ...checkWith];
    const t0 = Date.now();
    const cur = new Map<string, string | null>();
    const lists = new Map<string, Map<string, CatManifest>>();
    await Promise.all(
      roots.map(async (app) => {
        cur.set(app, await this.current(app, s));
        const list = latest && checked.includes(app) ? await this.latestOf(app, cur.get(app)!, cat, without) : await this.listOf(app, cur.get(app)!);
        if (apps.includes(app)) {
          if (change.version === null) list.delete(change.name);
          else list.set(change.name, change.version);
        }
        lists.set(app, await this.manifests(list));
      }),
    );
    const tList = Date.now();
    const inBuilds = new Set([...lists.values()].flatMap((l) => [...l.keys()]));
    // модуль во многих сборках (ядро страницы) — один раз: версии в сборках одного флота сверяются как одно имя
    const set = new Map<string, CatManifest>();
    for (const l of lists.values()) for (const [n, m] of l) if (!set.has(n) || checked.some((a) => lists.get(a)!.get(n) === m)) set.set(n, m);
    // остальной флот: Worker'ы и библиотеки каталога; приложение ОС — только выложенное: в stable или в плане машины
    const placed = (p: string) => !!s.stable[p] || Object.values(s.plans).some((plan) => !!plan[p]);
    for (const [p, e] of cat) {
      if (inBuilds.has(p) || !e.manifest || e.manifest.into || roots.includes(p)) continue;
      if (e.manifest.type === "os" && !placed(p)) continue;
      set.set(p, e.manifest);
    }
    const errors = check([...set.values()]);
    if (errors.length) throw new Refusal("check_failed", errors.join("; "));

    const changed = `${change.name} ${change.version ?? "снят"}${without.length ? `; сняты ${without.join(", ")}` : ""}`;
    const result: Deployed = { parts: {} };
    const stable = { ...s.stable };
    const built: Array<[string, string]> = [];
    for (const app of apps) {
      const tApp = Date.now();
      const mans = lists.get(app)!;
      const root = mans.get(app)!;
      const mods = order([...mans.values()].filter((m) => m.name !== app));
      const n = 1 + Math.max(0, ...(await this.machineVersions(app)).filter((v) => v.startsWith(`${root.version}+`)).map((v) => Number(v.split("+")[1])));
      const version = `${root.version}+${n}`;
      const modules = mods.map((m) => ({ name: m.name, version: m.version }));
      const k = kinds.get(app)!;
      // адреса Worker'ов и страниц, которыми пользуются корень и модули сборки (relay, gate, phone, …), — у Cloudflare по имени
      const owners = new Set([...mans.values()].flatMap((m) => Object.keys(m.uses ?? {}).map(ownerOf)));
      const used = [...kinds].filter(([p, kk]) => kk.where === "cloud" && owners.has(p)) as Array<[string, { script: string }]>;
      const urls = await urlsOf(this.env, used.map(([, kk]) => kk.script));
      const workers: Record<string, string> = Object.fromEntries(used.map(([p, kk]) => [p, urls[kk.script]]));
      const list: BuildList = { app, version, fleet: this.env.FLEET, modules, workers };
      let files: Array<{ path: string; data: Buffer }>;
      if (k.where === "cloud") {
        const shell = Buffer.from(await (await this.env.BUCKET.get(tgzKey(app, root.version)))!.arrayBuffer());
        const tgzs = await Promise.all(mods.map(async (m) => ({ name: m.name, tgz: Buffer.from(await (await this.env.BUCKET.get(tgzKey(m.name, m.version)))!.arrayBuffer()) })));
        files = webBuild(shell, tgzs, list) as Array<{ path: string; data: Buffer }>;
      } else {
        files = [...(await this.files(tgzKey(app, root.version)))];
        for (const m of mods) for (const x of await this.files(tgzKey(m.name, m.version))) files.push({ path: `modules/${m.name}/${x.path}`, data: x.data });
        files.push(buildFile(list) as { path: string; data: Buffer });
      }
      // архив сборки — под именем флота: следующая сборка начинается с его списка
      const tgz = pack(files);
      await this.env.BUCKET.put(this.tgz(app, version), tgz);
      await this.env.BUCKET.put(this.shaOf(app, version), shaLine(sha256hex(tgz), version));
      if (k.where === "cloud") {
        await deploy(this.env, k.script, await publishStatic(this.env, k.script, files, version));
        await this.journal(`${app} ${cur.get(app) ?? "—"} → ${version} (${changed})`, by);
      } else {
        stable[app] = version;
        built.push([app, version]);
      }
      result.parts[app] = { from: cur.get(app) ?? null, to: version };
      log({ kind: "note", ev: "rebuild", why: `${app} ${version}: списки и проверка ${tList - t0} мс, сборка и выкладка ${Date.now() - tApp} мс` });
    }
    const plans: Frame[] = [];
    if (built.length) {
      const rev = await this.save({ stable, plans: s.plans }, s.rev);
      for (const [app, v] of built) await this.journal(`${app} ${s.stable[app] ?? "—"} → ${v} (${changed})`, by);
      const next: Fleet = { stable, plans: s.plans, rev };
      for (const m of await this.machines()) {
        const plan = s.plans[m] ?? {};
        if (built.some(([app]) => (plan[app] ? !plan[app].pin : DEFAULT.includes(app)))) plans.push(await this.planFrame(next, m));
      }
    }
    return { result, plans };
  }

  /** Единственная правка плана машины. Уже так — ok с прежней rev. */
  private async set(f: Frame): Promise<{ result: SetResult; plans: Frame[] }> {
    const m = f.machine;
    const p = f.part;
    if (typeof m !== "string" || !NAME.test(m)) throw new Refusal("bad_frame", "machine — имя машины");
    if (typeof p !== "string" || !NAME.test(p) || (await this.script(p))) throw new Refusal("bad_frame", "part — имя части машины");
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
