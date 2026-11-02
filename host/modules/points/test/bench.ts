// Стенд модуля points: настоящее ядро Host на поддельных SDK, relay, keeper и часах;
// Worker points (реестр) и R2 — подделки в памяти, manage этой машины — модуль-подделка поверх ядра,
// manage соседней машины — участник рации, который пишет запросы и отвечает ok.
import { existsSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuse, stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { BLOCK, pack, projectDir, sha256, unpack } from "../src/blocks.ts";
import type { PointFile } from "../src/blocks.ts";
import { make } from "../src/points.ts";
import type { Git } from "../src/git.ts";

const { module, standHost } = stand;
type Stand = stand.Stand;

type Row = { id: number; sid: string; machine: string; why: string; base: number | null; files: PointFile[]; callsign?: string; dir?: string; git?: unknown; spec?: unknown };

/** Блоки байтов, как их режет модуль. */
export function blocks(buf: Buffer, p: string): { file: PointFile; data: Map<string, Buffer> } {
  const size = p.endsWith(".jsonl") ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const data = new Map<string, Buffer>();
  const b: string[] = [];
  for (let off = 0; off < size; off += BLOCK) {
    const part = buf.subarray(off, Math.min(size, off + BLOCK));
    const h = sha256(part);
    b.push(h);
    data.set(h, Buffer.from(part));
  }
  return { file: { p, size, b }, data };
}

/** Поддельный Worker points: тот же разбор хозяина и блоков, что у реестра, в памяти; R2 — словарь. */
export class FakeRegistry {
  r2 = new Map<string, Buffer>();
  rows = new Map<number, Row>();
  sessions = new Map<string, { owner: string; head: number }>();
  puts: Array<Frame & { result: string }> = [];
  deletes: Frame[] = [];
  gets: Frame[] = [];
  /** PUT в R2: ключи по порядку */
  r2puts: string[] = [];
  /** запросы машины в R2: метод, ключ и был ли свой заголовок подписи */
  r2calls: Array<{ method: string; key: string; signed: boolean }> = [];
  seq = 1000;
  /** ответить этим словом на следующий put (и owner) */
  refuseNext: { error: string; owner?: string } | null = null;

  /** Ссылки реестра: один блок, один метод — метод записан в ссылке, R2 стенда сверяет его. */
  links(method: "GET" | "PUT", hashes: string[]): Record<string, string> {
    return Object.fromEntries(hashes.map((h) => [h, `https://r2.test/bk/f/${h}?X-Amz-Signature=${method}`]));
  }

  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = u.pathname.split("/").slice(2).join("/");
    const method = init?.method ?? "GET";
    this.r2calls.push({ method, key, signed: !!(init?.headers as Record<string, string> | undefined)?.authorization });
    if (u.searchParams.get("X-Amz-Signature") !== method) return new Response("", { status: 403 });
    if (method === "PUT") {
      this.r2.set(key, Buffer.from(init!.body as Uint8Array));
      this.r2puts.push(key);
      return new Response("", { status: 200 });
    }
    const b = this.r2.get(key);
    return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response("", { status: 404 });
  }) as typeof fetch;

  /** Точка в реестре и её блоки в R2. */
  seed(id: number, sid: string, owner: string, files: Record<string, Buffer>, o: Partial<Row> = {}): Row {
    const pf: PointFile[] = [];
    for (const [p, buf] of Object.entries(files)) {
      const { file, data } = blocks(buf, p);
      pf.push(file);
      for (const [h, d] of data) this.r2.set(`f/${h}`, pack(d));
    }
    const row: Row = { id, sid, machine: owner, why: "save", base: null, files: pf, callsign: `site@${owner}`, ...o };
    this.rows.set(id, row);
    const s = this.sessions.get(sid);
    if (!s || s.head < id) this.sessions.set(sid, { owner, head: id });
    this.seq = Math.max(this.seq, id);
    return row;
  }

  bytes(id: number, p: string): Buffer {
    const f = this.rows.get(id)!.files.find((x) => x.p === p)!;
    return Buffer.concat(f.b.map((h) => unpack(this.r2.get(`f/${h}`)!)));
  }

  handle(f: Frame, machine: string): Record<string, unknown> {
    if (f.type === "points.get") {
      this.gets.push(f);
      const rows = (f.ids as number[]).map((i) => this.rows.get(i)).filter(Boolean) as Row[];
      if (!rows.length) return { ok: false, error: "no_point", ids: f.ids };
      return { ok: true, result: { owner: this.sessions.get(rows[0].sid)?.owner ?? null, points: rows, links: this.links("GET", [...new Set(rows.flatMap((r) => r.files.flatMap((x) => x.b)))]) } };
    }
    if (f.type === "points.delete") {
      this.deletes.push(f);
      const ids = [...this.rows.values()].filter((r) => r.sid === f.sid).map((r) => r.id);
      for (const i of ids) this.rows.delete(i);
      this.sessions.delete(f.sid as string);
      return { ok: true, result: { points: ids.length, blocks: 0, bytes: 0 } };
    }
    // points.put
    const files = f.files as PointFile[];
    const hashes = [...new Set(files.flatMap((x) => x.b))];
    const missing = hashes.filter((h) => !this.r2.has(`f/${h}`));
    const rec = (result: string, r: Record<string, unknown>) => (this.puts.push({ ...f, result } as Frame & { result: string }), r);
    if (this.refuseNext) {
      const x = this.refuseNext;
      this.refuseNext = null;
      return rec(x.error, { ok: false, ...x });
    }
    const sid = f.sid as string;
    const s = this.sessions.get(sid);
    const base = typeof f.base === "number" ? f.base : null;
    if (s && f.why === "raise" && f.expect !== s.owner) return rec("not_owner", { ok: false, error: "not_owner", owner: s.owner });
    if (s && f.why !== "raise" && f.why !== "yield" && machine !== s.owner) return rec("not_owner", { ok: false, error: "not_owner", owner: s.owner });
    if (missing.length) return rec("missing", { ok: false, error: "missing", missing, links: this.links("PUT", missing) });
    if (s && machine === s.owner && f.why !== "raise" && JSON.stringify(this.rows.get(s.head)?.files) === JSON.stringify(files)) {
      return rec("same", { ok: true, result: { id: s.head, same: true } });
    }
    const id = ++this.seq;
    this.rows.set(id, { id, sid, machine, why: f.why as string, base: base ?? s?.head ?? null, files, callsign: f.callsign as string, dir: f.dir as string, git: f.git, spec: f.spec });
    if (f.why !== "yield") this.sessions.set(sid, { owner: machine, head: id });
    return rec("ok", { ok: true, result: { id } });
  }
}

export type ManageCall = { type: string; [k: string]: unknown };

/**
 * Поддельный manage этой машины: открывает и поднимает сессии через ядро. fork — новый sid; файл нового разговора
 * claude пишет только на первом ходу (факт живого прогона 31 окт.) — подделка его не пишет, тест кладёт сам: forkWrite().
 */
export function fakeManage(calls: ManageCall[], o: { failOpen?: string; failStop?: string } = {}): Module {
  return {
    requests: {
      async "session.open"(f, { host }) {
        calls.push({ ...f });
        if (o.failOpen) throw refuse(o.failOpen);
        const callsign = `${f.name}@${host.machine}`;
        const s = await host.open({ callsign, cwd: f.dir as string, resume: f.resume as string, fork: f.fork === true, point: f.point as number });
        return { callsign, session_id: s.info.session_id };
      },
      async "session.start"(f, { host }) {
        calls.push({ ...f });
        await host.session(f.callsign as string)!.start(typeof f.point === "number" ? { point: f.point } : {});
        return undefined;
      },
      async "session.stop"(f, { host }) {
        calls.push({ ...f });
        if (o.failStop) throw refuse(o.failStop);
        await host.session(f.callsign as string)!.stop();
        return undefined;
      },
      async "session.remove"(f, { host }) {
        calls.push({ ...f });
        await host.session(f.callsign as string)!.remove();
        return undefined;
      },
      "session.spec"(f, { host }) {
        const s = host.session(f.callsign as string)!;
        return { dir: s.info.cwd, model: null, effort: null, title: "Сайт" };
      },
    },
  };
}

export type Bench = {
  st: Stand;
  reg: FakeRegistry;
  manage: ManageCall[];
  /** запросы к manage других машин через relay */
  remote: Frame[];
  home: string;
};

/** Стенд points: настоящее ядро, поддельный реестр Worker points и manage. */
export async function bench(o: {
  home: string;
  machine?: string;
  git?: Git;
  failOpen?: string;
  /** manage этой машины отказывает в session.stop этим словом */
  failStop?: string;
  /** ответ manage соседних машин; нет ответа — ok */
  remoteReply?: (f: Frame) => Record<string, unknown> | undefined;
  sessions?: Array<{ callsign: string; session_id?: string; cwd?: string }>;
  holders?: stand.FakeHolders;
  /** реестр, заполненный до старта Host */
  reg?: FakeRegistry;
  /** roster после hello придержан — связь с relay приходит позже подъёма сессий */
  holdRoster?: boolean;
}): Promise<Bench> {
  const reg = o.reg ?? new FakeRegistry();
  const manage: ManageCall[] = [];
  const remote: Frame[] = [];
  const machine = o.machine ?? "laptop";
  // ответы Worker points и manage соседних машин — с первого кадра, ещё до старта Host
  const relay = new stand.FakeRelay();
  relay.holdRoster = !!o.holdRoster;
  const recv = relay.receive.bind(relay);
  relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const f = JSON.parse(text) as Frame;
    if (typeof f.id !== "string" || f.type === "reply" || f.type === "hello") return;
    let r: Record<string, unknown>;
    if (f.type.startsWith("points.")) r = reg.handle(f, machine);
    else {
      remote.push(f);
      r = o.remoteReply?.(f) ?? { ok: true };
    }
    queueMicrotask(() => relay.deliver({ type: "reply", id: f.id as string, from: f.to ?? "x", ...r } as Frame));
  };
  const st = await standHost({
    home: o.home,
    machine,
    sessions: o.sessions,
    holders: o.holders,
    relayStand: relay,
    start: false,
    modules: [
      { manifest: fakeManageManifest(), module: fakeManage(manage, { failOpen: o.failOpen, failStop: o.failStop }) },
      { manifest: manifest as Manifest, module: make({ git: o.git, fetch: reg.fetch }) },
    ],
  });
  await st.start();
  return { st, reg, manage, remote, home: o.home };
}

function fakeManageManifest(): Manifest {
  return module("host-manage", fakeManage([]), {}).manifest;
}

export function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sb-points-"));
  mkdirSync(join(home, "claude", "projects"), { recursive: true });
  return home;
}

/** claude записал файл копии на первом ходу: разговор базы под новым sid. */
export function forkWrite(dir: string, from: string, to: string): void {
  const proj = projectDir(dir);
  copyFileSync(join(proj, `${from}.jsonl`), join(proj, `${to}.jsonl`));
}
