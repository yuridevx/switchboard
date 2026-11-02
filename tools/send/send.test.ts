// tools/send: одна попытка hello → roster → session.prompt → reply; relay — поддельный (test/fake-relay.mjs).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SEND = fileURLToPath(new URL("./send.mjs", import.meta.url));
const FAKE = pathToFileURL(fileURLToPath(new URL("./test/fake-relay.mjs", import.meta.url))).href;
const KEY = "client.alarm.k1a2.sig";

function run(args: string[], input: string, mode = "ok") {
  const log = join(mkdtempSync(join(tmpdir(), "switchboard-send-")), "frames.jsonl");
  const r = spawnSync(process.execPath, ["--import", FAKE, SEND, ...args], { input, encoding: "utf8", env: { ...process.env, FAKE_RELAY: mode, FAKE_LOG: log } });
  let frames: Array<Record<string, unknown>> = [];
  try {
    frames = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // relay не звали
  }
  return { ...r, frames };
}

describe("send", () => {
  it("2079 · сообщение дошло: hello ключом из первой строки stdin, после roster — session.prompt с текстом, ok и выход 0", () => {
    // источник: слово пользователя «send — сообщение в сессию от служб компьютера ключом клиента, без зависимостей»
    const r = run(["site@laptop", "--url", "wss://relay.test"], `${KEY}\nтревога: диск\nвторая строка`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
    const [open, hello, prompt, close] = r.frames;
    // relay машины сессии: объект /m/laptop
    expect(open).toEqual({ url: "wss://relay.test/m/laptop" });
    expect(hello).toEqual({ type: "hello", key: KEY, proto: 1 });
    expect(prompt).toMatchObject({ type: "session.prompt", v: 1, to: "site@laptop", callsign: "site@laptop", text: "тревога: диск\nвторая строка" });
    expect(typeof prompt.id).toBe("string");
    expect(close).toEqual({ close: 1000 });
    expect(r.frames.filter((f) => f.type === "session.prompt")).toHaveLength(1);
  });

  it("2080 · отказ relay или Host — ошибка словом, выход 1, повторов нет", () => {
    const off = run(["wiki@pc", "--url", "wss://relay.test"], `${KEY}\nтекст`, "offline");
    expect([off.status, off.stdout.trim()]).toEqual([1, "offline"]);
    expect(off.frames.filter((f) => f.type === "session.prompt")).toHaveLength(1);
    const bad = run(["wiki@pc", "--url", "wss://relay.test"], `${KEY}\nтекст`, "refuse");
    expect([bad.status, bad.stdout.trim()]).toEqual([1, "связь закрыта: 1008 bad_key"]);
    expect(bad.frames.filter((f) => f.type === "session.prompt")).toHaveLength(0);
  });

  it("2081 · ответа нет за срок — ошибка, сокет закрыт", async () => {
    process.env.FAKE_RELAY = "silent";
    delete process.env.FAKE_LOG;
    await import(FAKE);
    const { send } = (await import(pathToFileURL(SEND).href)) as { send: (cs: string, text: string, o: object) => Promise<{ ok: number; error: string }> };
    expect(await send("site@laptop", "x", { key: KEY, url: "wss://relay.test", timeoutMs: 100 })).toEqual({ ok: 0, error: "нет ответа за 100 мс" });
  });

  it("2082 · вход отклонён — строка вызова и выход 2, relay не звали", () => {
    for (const args of [[], ["site@laptop", "--zip", "x"], ["site@laptop", "--url"]]) {
      const r = run(args, `${KEY}\nтекст`);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("вызов:");
      expect(r.frames).toEqual([]);
    }
  });
});
