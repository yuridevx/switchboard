// Эталон 5057: switchboard redeem — приглашение из stdin, пропуск в stdout; погашенное — выход 1 со словом.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REDEEM = join(dirname(fileURLToPath(import.meta.url)), "..", "redeem.ts");
const used = new Set<string>();
let url = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const f = JSON.parse(body);
    const ok = f.type === "gate.redeem" && !used.has(f.invite);
    used.add(f.invite);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ok ? { type: "reply", id: f.id, ok: true, result: { key: `client.ci.${f.invite.split(".")[0]}.SECRET` } } : { type: "reply", id: f.id, ok: false, error: "bad_invite" }));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => server.close());

function run(args: string[], input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [REDEEM, ...args]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (status) => res({ status, stdout, stderr }));
    p.stdin.end(input);
  });
}

describe("redeem", () => {
  it("5057 · switchboard redeem → печатает пропуск, выход 0; погашенное приглашение → выход 1 со словом", async () => {
    const a = await run([url], "c1a2.INVITE\n");
    expect(a).toEqual({ status: 0, stdout: "client.ci.c1a2.SECRET\n", stderr: "" });
    const b = await run([url], "c1a2.INVITE");
    expect(b.status).toBe(1);
    expect(b.stdout).toBe("");
    expect(b.stderr).toBe("redeem: bad_invite\n");
  });
});
