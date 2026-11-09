// Объект флота: люди, проекты, пропуска, правило «достаёт» и картина флота. Один на флот; записи — в своём SQLite.
import { DurableObject } from "cloudflare:workers";
import {
  contract, fail, formatPass, type Frame, kindOf, machineOf, type MachineRow, ok, parseFrame, parsePass, type PassRow, personOf, type PersonRow,
  type Project, PROTO, Refusal, type Reply, type SessionRow, sha256hex, type Who,
} from "@sb/protocol";
import { type Card, cardOf, type Drop, type Env, log, randomText, type RowsChange, send, shut } from "./env.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

type PassRec = { kid: string; addr: string; person: string; hash: string; wait: number; at: number; seen: number | null };
type MachineRec = { name: string; owner: string; online: number; since: number; build: number | null; sdk: string | null; os: string | null; keeper: number | null };

const machineRow = (m: MachineRec): MachineRow => ({
  name: m.name, owner: m.owner, online: !!m.online, since: m.since,
  ...(m.build != null ? { build: m.build } : {}), ...(m.sdk ? { sdk: m.sdk } : {}), ...(m.os ? { os: m.os } : {}), ...(m.keeper != null ? { keeper: !!m.keeper } : {}),
});

export class FleetObject extends DurableObject<Env> {
  /** кто до каких машин достаёт; сбрасывается при любой смене людей, проектов и машин */
  private reachCache = new Map<string, Set<string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people(person TEXT PRIMARY KEY, name TEXT, admin INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(project TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY(project, person));
      CREATE TABLE IF NOT EXISTS passes(kid TEXT PRIMARY KEY, addr TEXT NOT NULL, person TEXT NOT NULL, hash TEXT NOT NULL, wait INTEGER NOT NULL, at INTEGER NOT NULL, seen INTEGER);
      CREATE TABLE IF NOT EXISTS machines(name TEXT PRIMARY KEY, owner TEXT NOT NULL, online INTEGER NOT NULL, since INTEGER NOT NULL, build INTEGER, sdk TEXT, os TEXT, keeper INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(callsign TEXT PRIMARY KEY, machine TEXT NOT NULL, row TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_machine ON sessions(machine);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private q<T>(sql: string, ...params: unknown[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...(params as SqlStorageValue[])).toArray() as T[];
  }

  private nextRev(): number {
    const was = this.q<{ v: string }>("SELECT v FROM meta WHERE k = 'rev'")[0];
    const rev = (was ? Number(was.v) : 0) + 1;
    this.q("INSERT INTO meta(k, v) VALUES('rev', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1", String(rev));
    return rev;
  }

  private rev(): number {
    const was = this.q<{ v: string }>("SELECT v FROM meta WHERE k = 'rev'")[0];
    return was ? Number(was.v) : 0;
  }

  /* ===== Кто пришёл и до чего достаёт ===== */

  private isAdmin(person: string): boolean {
    return !!this.q<{ admin: number }>("SELECT admin FROM people WHERE person = ?", person)[0]?.admin;
  }

  /** Правило «достаёт»: свои машины и машины тех, с кем общий проект; у админа — все. Считается только здесь. */
  private reach(person: string): Set<string> {
    let set = this.reachCache.get(person);
    if (set) return set;
    const rows = this.isAdmin(person)
      ? this.q<{ name: string }>("SELECT name FROM machines")
      : this.q<{ name: string }>(
          `SELECT name FROM machines WHERE owner = ?1 OR owner IN
             (SELECT m2.person FROM members m1 JOIN members m2 ON m1.project = m2.project WHERE m1.person = ?1)`,
          person,
        );
    set = new Set(rows.map((r) => r.name));
    this.reachCache.set(person, set);
    return set;
  }

  reaches(person: string, machine: string): boolean {
    return this.reach(person).has(machine);
  }

  async who(key: string, as?: string): Promise<Who | { error: string; why?: string }> {
    const p = parsePass(key);
    if (!p) return { error: "bad_key", why: "пропуск не того вида" };
    const rec = this.q<PassRec>("SELECT * FROM passes WHERE kid = ?", p.kid)[0];
    if (!rec || rec.wait || rec.hash !== (await sha256hex(p.secret))) return { error: "bad_key", why: "пропуск не принят" };
    const now = Date.now();
    if (!rec.seen || now - rec.seen > HOUR) this.q("UPDATE passes SET seen = ? WHERE kid = ?", now, rec.kid);
    let addr = rec.addr;
    if (as !== undefined) {
      // машина говорит за свои сессии — и только за свои
      if (kindOf(rec.addr) !== "machine" || kindOf(as) !== "session" || machineOf(as) !== machineOf(rec.addr)) return { error: "forbidden", why: "позывной не этой машины" };
      addr = as;
    }
    return { kid: rec.kid, addr, person: rec.person, admin: this.isAdmin(rec.person), machines: [...this.reach(rec.person)] };
  }

  /* ===== Запросы объекту флота ===== */

  async call(fleet: string, who: Who | null, frame: Frame): Promise<{ reply: Reply; drop?: Drop }> {
    const id = frame.id ?? "";
    const def = contract.request(frame.type);
    if (!def || def.target !== "fleet") return { reply: fail(id, "unknown_request", frame.type + " — не запрос объекту флота") };
    const parsed = def.input.safeParse(frame);
    if (!parsed.success) return { reply: fail(id, "bad_input", parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")) };
    try {
      if (!def.open && !who) throw new Refusal("bad_key", "нужен пропуск");
      if (def.admin && !who!.admin) throw new Refusal("forbidden", "только админ флота");
      const out = await this.handle(fleet, who, frame.type, parsed.data as any);
      return { reply: ok(id, out.result ?? {}), ...(out.drop ? { drop: out.drop } : {}) };
    } catch (e) {
      if (e instanceof Refusal) return { reply: fail(id, e.word, e.why) };
      log.error("запрос объекту флота упал", { type: frame.type, trace: frame.trace, fleet, why: e instanceof Error ? e.message : String(e) });
      return { reply: fail(id, "module_failed", e instanceof Error ? e.message : String(e)) };
    }
  }

  private async handle(fleet: string, who: Who | null, type: string, i: any): Promise<{ result?: unknown; drop?: Drop }> {
    switch (type) {
      case "redeem":
        return { result: await this.redeem(i.invite) };
      case "invite":
        return { result: await this.invite(fleet, who!, i.addr, i.owner) };
      case "passes": {
        const rows = who!.admin ? this.q<PassRec>("SELECT * FROM passes ORDER BY at DESC") : this.q<PassRec>("SELECT * FROM passes WHERE person = ? ORDER BY at DESC", who!.person);
        const passes: PassRow[] = rows.map((r) => ({ kid: r.kid, addr: r.addr, person: r.person, wait: !!r.wait, at: r.at, ...(r.seen ? { seen: r.seen } : {}) }));
        return { result: { passes } };
      }
      case "revoke":
        return this.revoke(who!, i.kid);
      case "whoami":
        return { result: { addr: who!.addr, person: who!.person, admin: who!.admin, machines: who!.machines, fleet } };
      case "people.list":
        return { result: this.peopleList() };
      case "people.set":
        return this.peopleSet(i);
      case "people.remove":
        return this.peopleRemove(i.person);
      case "project.set":
        return this.projectSet(i);
      case "project.remove": {
        const members = this.q<{ person: string }>("SELECT person FROM members WHERE project = ?", i.id).map((r) => r.person);
        this.q("DELETE FROM members WHERE project = ?", i.id);
        this.q("DELETE FROM projects WHERE id = ?", i.id);
        return { drop: this.access(members) };
      }
    }
    throw new Refusal("unknown_request", type);
  }

  private async issue(fleet: string, addr: string, person: string): Promise<{ kid: string; invite: string }> {
    const now = Date.now();
    const taken = this.q<PassRec>("SELECT * FROM passes WHERE addr = ?", addr);
    if (taken.some((r) => !r.wait)) throw new Refusal("name_taken", "у адреса " + addr + " уже есть пропуск");
    // непринятые приглашения на тот же адрес заменяются новым
    this.q("DELETE FROM passes WHERE addr = ? AND wait = 1", addr);
    const kid = randomText(10), secret = randomText(32);
    this.q("INSERT INTO passes(kid, addr, person, hash, wait, at) VALUES(?, ?, ?, ?, 1, ?)", kid, addr, person, await sha256hex(secret), now);
    return { kid, invite: formatPass({ fleet, kid, secret }) };
  }

  private async invite(fleet: string, who: Who, addr: string, owner?: string): Promise<{ kid: string; invite: string }> {
    const kind = kindOf(addr);
    let person: string;
    if (kind === "device") {
      if (owner) throw new Refusal("bad_input", "владелец бывает только у машины");
      person = personOf(addr)!;
    } else if (kind === "machine") person = owner ?? who.person;
    else throw new Refusal("bad_input", "приглашают устройство вида pult~a@b.c или машину вида @laptop");
    const known = this.q("SELECT 1 FROM people WHERE person = ?", person).length > 0;
    // своё — любой; чужое и нового человека — админ
    if (person !== who.person && !who.admin) throw new Refusal("forbidden", "чужое приглашает админ флота");
    if (!known) this.q("INSERT INTO people(person, admin, at) VALUES(?, 0, ?)", person, Date.now());
    return this.issue(fleet, addr, person);
  }

  private async redeem(invite: string): Promise<{ key: string; addr: string }> {
    const p = parsePass(invite);
    if (!p) throw new Refusal("bad_invite", "приглашение не того вида");
    const rec = this.q<PassRec>("SELECT * FROM passes WHERE kid = ?", p.kid)[0];
    if (!rec || !rec.wait || rec.hash !== (await sha256hex(p.secret))) throw new Refusal("bad_invite", "приглашения нет или оно уже принято");
    const now = Date.now();
    if (now - rec.at > DAY) throw new Refusal("bad_invite", "приглашение старше суток");
    const secret = randomText(40);
    this.q("UPDATE passes SET hash = ?, wait = 0, at = ?, seen = ? WHERE kid = ?", await sha256hex(secret), now, now, rec.kid);
    if (kindOf(rec.addr) === "machine") {
      const name = machineOf(rec.addr)!;
      this.q("INSERT INTO machines(name, owner, online, since) VALUES(?, ?, 0, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner", name, rec.person, now);
      this.reachCache.clear();
      const m = this.q<MachineRec>("SELECT * FROM machines WHERE name = ?", name)[0]!;
      this.emit(name, { machines: [machineRow(m)] });
    }
    return { key: formatPass({ fleet: p.fleet, kid: rec.kid, secret }), addr: rec.addr };
  }

  private revoke(who: Who, kid: string): { drop: Drop } {
    const rec = this.q<PassRec>("SELECT * FROM passes WHERE kid = ?", kid)[0];
    if (!rec) throw new Refusal("not_found", "такого пропуска нет");
    if (rec.person !== who.person && !who.admin) throw new Refusal("forbidden", "чужой пропуск отзывает админ флота");
    this.q("DELETE FROM passes WHERE kid = ?", kid);
    if (kindOf(rec.addr) === "machine" && !rec.wait) this.removeMachine(machineOf(rec.addr)!);
    for (const ws of this.ctx.getWebSockets()) {
      const c = cardOf(ws);
      if (c.role === "page" && c.kid === kid) shut(ws, "revoked");
    }
    return { drop: { kids: [kid] } };
  }

  private removeMachine(name: string): void {
    const viewers = this.viewers(name);
    this.q("DELETE FROM sessions WHERE machine = ?", name);
    this.q("DELETE FROM machines WHERE name = ?", name);
    this.reachCache.clear();
    const rev = this.nextRev();
    for (const ws of viewers) send(ws, { type: "roster.delta", rev, gone: [name] });
  }

  private peopleList(): { people: PersonRow[]; projects: Project[] } {
    const members = this.q<{ project: string; person: string }>("SELECT project, person FROM members");
    const people = this.q<{ person: string; name: string | null; admin: number; at: number }>("SELECT * FROM people ORDER BY at").map((p) => ({
      person: p.person, ...(p.name ? { name: p.name } : {}), admin: !!p.admin, projects: members.filter((m) => m.person === p.person).map((m) => m.project), at: p.at,
    }));
    const projects = this.q<{ id: string; name: string }>("SELECT * FROM projects ORDER BY id").map((p) => ({ id: p.id, name: p.name, members: members.filter((m) => m.project === p.id).map((m) => m.person) }));
    return { people, projects };
  }

  /** Смена доступа: сбросить расчёт и переподключить затронутых — они получат новую картину. */
  private access(persons: string[]): Drop {
    this.reachCache.clear();
    const set = new Set(persons);
    for (const ws of this.ctx.getWebSockets()) {
      const c = cardOf(ws);
      if (c.role === "page" && set.has(c.person)) shut(ws, "access");
    }
    return { persons: [...set] };
  }

  private membersOf(projects: string[]): string[] {
    if (!projects.length) return [];
    return this.q<{ person: string }>(`SELECT DISTINCT person FROM members WHERE project IN (${projects.map(() => "?").join(",")})`, ...projects).map((r) => r.person);
  }

  private peopleSet(i: { person: string; name?: string; admin?: boolean; projects?: string[] }): { drop?: Drop } {
    const was = this.q<{ admin: number }>("SELECT admin FROM people WHERE person = ?", i.person)[0];
    if (!was) this.q("INSERT INTO people(person, admin, at) VALUES(?, 0, ?)", i.person, Date.now());
    if (i.name !== undefined) this.q("UPDATE people SET name = ? WHERE person = ?", i.name, i.person);
    let touched: string[] = [];
    if (i.admin !== undefined && !!was?.admin !== i.admin) {
      this.q("UPDATE people SET admin = ? WHERE person = ?", i.admin ? 1 : 0, i.person);
      touched.push(i.person);
    }
    if (i.projects) {
      for (const id of i.projects) if (!this.q("SELECT 1 FROM projects WHERE id = ?", id).length) throw new Refusal("not_found", "проекта " + id + " нет");
      const old = this.q<{ project: string }>("SELECT project FROM members WHERE person = ?", i.person).map((r) => r.project);
      const changed = [...old.filter((p) => !i.projects!.includes(p)), ...i.projects.filter((p) => !old.includes(p))];
      if (changed.length) {
        touched = [...touched, i.person, ...this.membersOf(changed)];
        this.q("DELETE FROM members WHERE person = ?", i.person);
        for (const id of i.projects) this.q("INSERT INTO members(project, person) VALUES(?, ?)", id, i.person);
      }
    }
    return touched.length ? { drop: this.access(touched) } : {};
  }

  private peopleRemove(person: string): { drop: Drop } {
    if (!this.q("SELECT 1 FROM people WHERE person = ?", person).length) throw new Refusal("not_found", "такого человека нет");
    const kids = this.q<{ kid: string }>("SELECT kid FROM passes WHERE person = ?", person).map((r) => r.kid);
    const near = this.membersOf(this.q<{ project: string }>("SELECT project FROM members WHERE person = ?", person).map((r) => r.project));
    for (const m of this.q<{ name: string }>("SELECT name FROM machines WHERE owner = ?", person)) this.removeMachine(m.name);
    this.q("DELETE FROM passes WHERE person = ?", person);
    this.q("DELETE FROM members WHERE person = ?", person);
    this.q("DELETE FROM people WHERE person = ?", person);
    for (const ws of this.ctx.getWebSockets()) {
      const c = cardOf(ws);
      if (c.role === "page" && c.person === person) shut(ws, "revoked");
    }
    const drop = this.access(near.filter((p) => p !== person));
    return { drop: { kids, persons: drop.persons } };
  }

  private projectSet(i: { id: string; name: string; members?: string[] }): { drop?: Drop } {
    this.q("INSERT INTO projects(id, name) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name", i.id, i.name);
    if (!i.members) return {};
    for (const p of i.members) if (!this.q("SELECT 1 FROM people WHERE person = ?", p).length) throw new Refusal("not_found", "человека " + p + " нет во флоте");
    const old = this.q<{ person: string }>("SELECT person FROM members WHERE project = ?", i.id).map((r) => r.person);
    const same = old.length === i.members.length && old.every((p) => i.members!.includes(p));
    if (same) return {};
    this.q("DELETE FROM members WHERE project = ?", i.id);
    for (const p of i.members) this.q("INSERT INTO members(project, person) VALUES(?, ?)", i.id, p);
    return { drop: this.access([...old, ...i.members]) };
  }

  /** Завести флот: первый человек — админ; ответ — приглашение его первого устройства. */
  async boot(fleet: string, person: string): Promise<{ invite: string; addr: string } | { error: string; why: string }> {
    if (kindOf(person) !== "person") return { error: "bad_input", why: "человек вида ~a@b.c" };
    if (this.q("SELECT 1 FROM people LIMIT 1").length) return { error: "exists", why: "флот уже заведён" };
    this.q("INSERT INTO people(person, admin, at) VALUES(?, 1, ?)", person, Date.now());
    this.q("INSERT INTO meta(k, v) VALUES('fleet', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", fleet);
    const addr = "pult" + person;
    const { invite } = await this.issue(fleet, addr, person);
    return { invite, addr };
  }

  /* ===== Картина ===== */

  /** Страницы, которым видна машина. */
  private viewers(machine: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const c = cardOf(ws);
      if (c.role === "page" && this.reach(c.person).has(machine)) out.push(ws);
    }
    return out;
  }

  private emit(machine: string, delta: { machines?: MachineRow[]; sessions?: Array<{ callsign: string; row: Partial<SessionRow> | null }> }): void {
    const rev = this.nextRev();
    for (const ws of this.viewers(machine)) send(ws, { type: "roster.delta", rev, ...delta });
  }

  /** Изменение от объекта машины. Снимок заменяет строки машины; изменение строки сливается; обрыв — «нет связи», строки остаются. */
  rows(machine: string, change: RowsChange): void {
    const m = this.q<MachineRec>("SELECT * FROM machines WHERE name = ?", machine)[0];
    if (!m) return; // машины во флоте нет: её пропуск отозван
    const now = Date.now();
    if (change.kind === "snapshot") {
      const was = new Set(this.q<{ callsign: string }>("SELECT callsign FROM sessions WHERE machine = ?", machine).map((r) => r.callsign));
      this.q("DELETE FROM sessions WHERE machine = ?", machine);
      for (const s of change.sessions) {
        this.q("INSERT OR REPLACE INTO sessions(callsign, machine, row) VALUES(?, ?, ?)", s.callsign, machine, JSON.stringify(s));
        was.delete(s.callsign);
      }
      this.q("UPDATE machines SET online = 1, since = ?, build = ?, sdk = ?, os = ? WHERE name = ?", m.online ? m.since : now, change.build ?? null, change.sdk ?? null, change.os ?? null, machine);
      const row = machineRow(this.q<MachineRec>("SELECT * FROM machines WHERE name = ?", machine)[0]!);
      this.emit(machine, { machines: [row], sessions: [...change.sessions.map((s) => ({ callsign: s.callsign, row: s })), ...[...was].map((callsign) => ({ callsign, row: null }))] });
      return;
    }
    if (change.kind === "delta") {
      if (machineOf(change.callsign) !== machine) return;
      if (change.row === null) this.q("DELETE FROM sessions WHERE callsign = ?", change.callsign);
      else {
        const was = this.q<{ row: string }>("SELECT row FROM sessions WHERE callsign = ?", change.callsign)[0];
        const row = { ...(was ? JSON.parse(was.row) : { callsign: change.callsign }), ...change.row };
        this.q("INSERT OR REPLACE INTO sessions(callsign, machine, row) VALUES(?, ?, ?)", change.callsign, machine, JSON.stringify(row));
      }
      this.emit(machine, { sessions: [{ callsign: change.callsign, row: change.row }] });
      return;
    }
    if (change.kind === "offline") {
      if (!m.online) return;
      this.q("UPDATE machines SET online = 0, since = ? WHERE name = ?", now, machine);
    } else {
      if (!!m.keeper === change.on) return;
      this.q("UPDATE machines SET keeper = ? WHERE name = ?", change.on ? 1 : 0, machine);
    }
    this.emit(machine, { machines: [machineRow(this.q<MachineRec>("SELECT * FROM machines WHERE name = ?", machine)[0]!)] });
  }

  online(person: string): boolean {
    return this.ctx.getWebSockets().some((ws) => {
      const c = cardOf(ws);
      return c.role === "page" && c.person === person;
    });
  }

  machines(): MachineRow[] {
    return this.q<MachineRec>("SELECT * FROM machines ORDER BY name").map(machineRow);
  }

  /* ===== Соединения страниц ===== */

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("нужен WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: "new" } satisfies Card);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (cardOf(ws).role !== "new") return; // страница после входа только слушает
    const f = typeof data === "string" ? parseFrame(data) : null;
    if (!f || f.type !== "hello" || f.role !== "page") return shut(ws, "bad_frame");
    if (f.proto !== PROTO) return shut(ws, "proto");
    const who = await this.who(String(f.key));
    if ("error" in who) {
      log.warn("страница не вошла", { word: who.error, why: who.why });
      return shut(ws, who.error);
    }
    if (kindOf(who.addr) !== "device") return shut(ws, "forbidden");
    const fleet = parsePass(f.key)!.fleet;
    ws.serializeAttachment({ role: "page", kid: who.kid, addr: who.addr, person: who.person, admin: who.admin, fleet } satisfies Card);
    const reach = this.reach(who.person);
    const machines = this.machines().filter((m) => reach.has(m.name));
    const sessions = this.q<{ machine: string; row: string }>("SELECT machine, row FROM sessions").filter((s) => reach.has(s.machine)).map((s) => JSON.parse(s.row) as SessionRow);
    send(ws, { type: "roster", rev: this.rev(), you: { addr: who.addr, person: who.person, admin: who.admin }, machines, sessions });
    log.info("страница вошла", { fleet, from: who.addr });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // уже закрыто
    }
  }
}
