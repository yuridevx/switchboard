// Живой прогон: настоящий Agent SDK 0.3.311 и настоящий claude, модель claude-haiku-4-5, временная папка проекта.
// Без SWITCHBOARD_LIVE=1 пропускается. Вместо keeper — маленький держатель процессов того же протокола.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { Module } from "../contract.ts";
import { Kernel } from "../src/kernel.ts";
import { claudePath } from "../src/release.ts";
import { CORE, module, until } from "../stand/index.ts";

/** Держатель процессов по протоколу keeper proto 1: control, list, kill, ready, spawn. */
async function liveKeeper() {
  const key = randomBytes(32).toString("hex");
  const procs = new Map<string, { child: ChildProcess; sock: net.Socket | null }>();
  let control: net.Socket | null = null;
  const server = net.createServer((sock) => {
    let head: Buffer | null = Buffer.alloc(0);
    sock.on("error", () => {});
    const onData = (b: Buffer) => {
      head = Buffer.concat([head!, b]);
      const i = head.indexOf(10);
      if (i < 0) return;
      const first = JSON.parse(head.subarray(0, i).toString());
      const rest = head.subarray(i + 1);
      head = null;
      sock.off("data", onData);
      const reply = (r: object) => sock.write(JSON.stringify({ op: "reply", ...r }) + "\n");
      if (first.key !== key) return void (reply({ ok: false, error: "bad_key" }), sock.end());
      if (first.op === "control") {
        control = sock;
        reply({ ok: true, result: { keeper: "live" } });
        let buf = "";
        sock.on("data", (d) => {
          buf += d;
          for (let j = buf.indexOf("\n"); j >= 0; j = buf.indexOf("\n")) {
            const x = JSON.parse(buf.slice(0, j));
            buf = buf.slice(j + 1);
            if (x.op === "list") reply({ ok: true, result: { processes: [...procs].map(([id, p]) => ({ id, pid: p.child.pid })) } });
            else if (x.op === "kill") {
              const p = procs.get(x.id);
              if (!p) reply({ ok: false, error: "unknown_id" });
              else {
                reply({ ok: true });
                if (x.force) p.child.kill();
                else p.child.stdin!.end();
              }
            } else reply({ ok: true });
          }
        });
        return;
      }
      if (first.op === "spawn") {
        const child = spawn(first.command, first.args, { cwd: first.cwd, env: first.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const p = { child, sock: sock as net.Socket | null };
        procs.set(first.id, p);
        let err = "";
        child.stderr!.on("data", (d) => (err = String(d).trim().split("\n").at(-1) ?? ""));
        reply({ ok: true, result: { pid: child.pid } });
        child.stdout!.on("data", (d) => p.sock?.write(d));
        sock.on("data", (d) => child.stdin!.write(d));
        if (rest.length) child.stdin!.write(rest);
        sock.on("close", () => (p.sock = null));
        child.on("exit", (code, signal) => {
          procs.delete(first.id);
          const ev = JSON.stringify({ op: "exited", id: first.id, pid: child.pid, code, signal, stderr: err }) + "\n";
          if (p.sock) p.sock.end(() => control?.write(ev));
          else control?.write(ev);
        });
        return;
      }
      reply({ ok: false, error: "unknown_op" });
      sock.end();
    };
    sock.on("data", onData);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { addr: { host: "127.0.0.1", port, key }, close: () => server.close() };
}

describe.skipIf(process.env.SWITCHBOARD_LIVE !== "1")("живой прогон: настоящий SDK и claude", () => {
  it("ход сессии через ядро: spawn у держателя, хук и поле модуля, result, штатный stop", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-live-"));
    const project = mkdtempSync(join(tmpdir(), "switchboard-live-project-"));
    writeFileSync(join(project, "README.md"), "Временная папка живого прогона Switchboard.\n");
    const k = await liveKeeper();
    const events: string[] = [];
    const live: Module = {
      session: (s) => ({ model: "claude-haiku-4-5", append: `Твой callsign — ${s.info.callsign}.` }),
      fields: { turns: (s) => s.store<number>().get() ?? 0 },
      on: {
        event(s, m) {
          events.push(m.type);
          if (m.type === "result") s.store<number>().update((n = 0) => n + 1);
        },
      },
    };
    const functions: Record<string, (...a: any[]) => Promise<unknown>> = {};
    for (const [n, f] of Object.entries(sdk)) if (typeof f === "function") functions[n] = f as never;
    const kernel = new Kernel({
      home,
      config: { machine: "live" },
      core: CORE,
      release: { version: "live", core: CORE.version, sdk: "0.3.311", modules: [module("host-live", live)] },
      sdk: { query: sdk.query, functions, cli: async () => ({ code: 0, out: "" }) },
      keeper: k.addr,
    });
    await kernel.start();
    const s = await kernel.open({ callsign: "lab@live", cwd: project });
    expect(s.state).toBe("idle");
    s.facade(kernel.mods[0]).input("Ответь одним словом: пинг");
    await until(() => events.includes("result") && s.state === "idle", 120_000);
    expect(s.record()).toMatchObject({ callsign: "lab@live", state: "idle", sdk: "0.3.311", turns: 1 });
    expect(s.model).toContain("haiku");
    await s.stop();
    expect(s.state).toBe("stopped");
    k.close();
    expect(claudePath(join(import.meta.dirname, ".."))).toBeTruthy();
  }, 180_000);
});
