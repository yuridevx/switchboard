// Леса switchboard pull: вход — команда и окружение, points и хранилище — подделки fetch; исход — файлы на диске и строки вывода.
// Номер — эталон-источник; без номера — чьё: код.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectDirOf, pull, Refused } from "../contract.ts";

const SID = "9f1c0000-0000-4000-8000-000000000001";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const conversation = Buffer.from('{"type":"user","uuid":"u1","message":{"role":"user","content":"привет"}}\n{"type":"assistant","uuid":"a1"}\n');
const side = Buffer.from('{"type":"user","uuid":"s1"}\n');
const blocks = new Map<string, Buffer>([conversation, side].map((b) => [sha(b), zstdCompressSync(b)]));
const row = { id: 412, sid: SID, callsign: "site@laptop", dir: "/home/ann/site", files: [{ p: `${SID}.jsonl`, size: conversation.length, b: [sha(conversation)] }, { p: `${SID}/subagents/agent-1.jsonl`, size: side.length, b: [sha(side)] }] };

let home: string;
let asked: Array<Record<string, unknown>>;
const env = () => ({ SWITCHBOARD_POINTS: "https://points.test/", SWITCHBOARD_PASS: "client.pult.k1.s", CLAUDE_CONFIG_DIR: join(home, ".claude") });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-pull-"));
  asked = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "https://points.test/") {
      const f = JSON.parse(init!.body!);
      asked.push(f);
      const reply = (result: unknown) => new Response(JSON.stringify({ type: "reply", id: f.id, ok: true, result }));
      if (f.type === "points.list") return reply({ search: false, sessions: [{ sid: SID, callsign: "site@laptop", owner: "laptop", head: { id: 412, at: 1 }, points: 3, branches: 0 }] });
      if (f.type === "points.get") return reply({ owner: "laptop", points: [row], links: Object.fromEntries([...blocks.keys()].map((h) => [h, `https://blocks.test/b/${h}`])) });
    }
    const h = /\/b\/([0-9a-f]{64})$/.exec(url)?.[1];
    return h && blocks.has(h) ? new Response(new Uint8Array(blocks.get(h)!)) : new Response(null, { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("switchboard pull", () => {
  it("35 · сессия по callsign: последняя точка, файл разговора и субагенты — побайтно в папке проекта Claude; команда продолжения", async () => {
    const out: string[] = [];
    const dir = join(home, "work", "site");
    expect(await pull(["site@laptop", "--dir", dir], env(), (l) => out.push(l))).toBe(0);
    const target = projectDirOf(join(home, ".claude"), dir);
    expect(readFileSync(join(target, `${SID}.jsonl`)).equals(conversation)).toBe(true);
    expect(readFileSync(join(target, SID, "subagents", "agent-1.jsonl")).equals(side)).toBe(true);
    expect(out.at(-1)).toBe(`cd ${JSON.stringify(dir)} && claude --resume ${SID}`);
    expect(asked.map((f) => [f.type, f.v, f.key])).toEqual([
      ["points.list", 2, "client.pult.k1.s"],
      ["points.get", 2, "client.pult.k1.s"],
    ]);
    expect(asked[1].ids).toEqual([412]);
  });

  it("--point — эта точка; блок не тот — отказ bad_point, файлов нет", async () => {
    blocks.set(sha(conversation), zstdCompressSync(Buffer.from("{}\n")));
    const dir = join(home, "w2");
    await expect(pull([SID.slice(0, 8), "--point", "7", "--dir", dir], env(), () => {})).rejects.toMatchObject({ word: "bad_point" });
    expect(asked[1].ids).toEqual([7]);
    expect(existsSync(join(projectDirOf(join(home, ".claude"), dir), `${SID}.jsonl`))).toBe(false);
    blocks.set(sha(conversation), zstdCompressSync(conversation));
  });

  it("нет адреса или пропуска — ошибка словами; незнакомая сессия — no_point", async () => {
    await expect(pull(["site@laptop"], {}, () => {})).rejects.toThrow(/SWITCHBOARD_POINTS/);
    await expect(pull(["ghost@laptop"], env(), () => {})).rejects.toBeInstanceOf(Refused);
    await expect(pull([], env(), () => {})).rejects.toThrow(/switchboard pull/);
  });
});
