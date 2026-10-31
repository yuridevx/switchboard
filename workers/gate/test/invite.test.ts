// Эталон 116: switchboard invite — секрет из stdin, ключ в stdout.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyKey } from "../src/key.ts";

const INVITE = join(dirname(fileURLToPath(import.meta.url)), "..", "invite.ts");
const SECRET = "секрет-теста-116";
const run = (args: string[], input: string) => spawnSync(process.execPath, [INVITE, ...args], { input, encoding: "utf8" });

describe("invite", () => {
  it("116 · секрет в stdin: одна строка host.laptop.<kid>.<sig>; verify тем же секретом даёт host laptop; секрета в аргументах нет", async () => {
    const args = ["host", "laptop"];
    const r = run(args, SECRET + "\n");
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^host\.laptop\.[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyKey(lines[0], SECRET, [], () => {})).toMatchObject({ role: "host", name: "laptop" });
    expect(await verifyKey(lines[0], "другой", [], () => {})).toEqual({ error: "bad_key" });
    expect(args.join(" ")).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
  });

  it("--url: адрес приложения, ключ после #", async () => {
    const r = run(["client", "panel-desk", "--url", "https://pult.example"], SECRET);
    expect(r.status).toBe(0);
    const m = r.stdout.trim().match(/^https:\/\/pult\.example\/#(client\.panel-desk\.[a-z0-9]{4}\.[A-Za-z0-9_-]+)$/);
    expect(m).not.toBeNull();
    expect(await verifyKey(m![1], SECRET, [], () => {})).toMatchObject({ role: "client", name: "panel-desk" });
  });

  it("--qr: QR в stderr, адрес с ключом — в stdout", () => {
    const r = run(["client", "phone", "--qr", "https://phone.example/"], SECRET);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^https:\/\/phone\.example\/#client\.phone\./);
    expect(r.stderr.length).toBeGreaterThan(100);
  });

  it("каждый ключ — свой номер", () => {
    const a = run(["client", "nightly"], SECRET).stdout.split(".")[2];
    const b = run(["client", "nightly"], SECRET).stdout.split(".")[2];
    expect(a).not.toBe(b);
  });

  it("пустой stdin — отказ; неверная роль — подсказка", () => {
    expect(run(["host", "laptop"], "").status).toBe(1);
    const r = run(["admin", "laptop"], SECRET);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("использование");
  });
});
