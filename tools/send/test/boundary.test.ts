// Леса границы «сообщение в сессию от служб компьютера»: настоящий процесс send.mjs и настоящий импорт; поддельный только relay.
// Источник свойства — слово пользователя (устав: «send — сообщение в сессию от служб компьютера ключом клиента, без зависимостей»); без пометки — чьё: код.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SEND = fileURLToPath(new URL("../send.mjs", import.meta.url));
const FAKE = pathToFileURL(fileURLToPath(new URL("./fake-relay.mjs", import.meta.url))).href;
const KEY = "client.alarm.k1a2.sig";
const URL_ARG = ["--url", "wss://relay.test"];
const USAGE = "вызов: <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]";

function run(args: string[], input: string, mode = "ok") {
  const log = join(mkdtempSync(join(tmpdir(), "switchboard-send-")), "frames.jsonl");
  const r = spawnSync(process.execPath, ["--import", FAKE, SEND, ...args], { input, encoding: "utf8", env: { ...process.env, FAKE_RELAY: mode, FAKE_LOG: log } });
  let frames: Array<Record<string, unknown>> = [];
  try {
    frames = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // relay не звали
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, frames, prompts: frames.filter((f) => f.type === "session.prompt") };
}

describe("командная строка", () => {
  it("2079 · сообщение дошло: relay машины сессии, hello ключом из первой строки stdin, после roster — один session.prompt с текстом, сокет закрыт, ok и выход 0", () => {
    const r = run(["site@laptop", ...URL_ARG], `${KEY}\nтревога: диск\nвторая строка`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("ok\n");
    expect(r.frames).toEqual([
      { url: "wss://relay.test/m/laptop" },
      { type: "hello", key: KEY, proto: 1 },
      { type: "session.prompt", v: 1, id: expect.any(String), to: "site@laptop", callsign: "site@laptop", text: "тревога: диск\nвторая строка" },
      { close: 1000 },
    ]);
  });

  it.each([
    ["без --url — настоящий relay", ["site@laptop"], "wss://relay.pfarm.app/m/laptop"],
    ["косая черта в конце адреса снимается", ["site@laptop", "--url", "wss://relay.test/"], "wss://relay.test/m/laptop"],
  ])("адрес: %s", (_n, args, url) => {
    expect(run(args, `${KEY}\nтекст`).frames[0]).toEqual({ url });
  });

  it.each([
    ["пробелы и перевод строки Windows вокруг ключа снимаются", `  ${KEY} \r\nтекст`, KEY, "текст"],
    ["текст не обрезается: пустые строки и пробелы целы", `${KEY}\n\n  текст \n`, KEY, "\n  текст \n"],
    ["одна строка — ключ, текст пустой", KEY, KEY, ""],
  ])("stdin: %s", (_n, input, key, text) => {
    const r = run(["site@laptop", ...URL_ARG], input);
    expect(r.frames[1]).toEqual({ type: "hello", key, proto: 1 });
    expect(r.prompts[0].text).toBe(text);
    expect(r.status).toBe(0);
  });

  it.each([
    ["2080 · Host отказал", "offline", "offline", 1],
    ["отказ без слова", "wordless", "undefined", 1],
    ["2080 · relay не пустил: код и причина закрытия, запроса нет", "refuse", "связь закрыта: 1008 bad_key", 0],
    ["связь оборвалась после запроса", "drop", "связь закрыта: 1006 ", 1],
  ])("отказ словом, выход 1, повторов нет: %s", (_n, mode, word, prompts) => {
    const r = run(["wiki@pc", ...URL_ARG], `${KEY}\nтекст`, mode);
    expect([r.status, r.stdout]).toEqual([1, `${word}\n`]);
    expect(r.prompts).toHaveLength(prompts);
    expect(r.frames.filter((f) => f.type === "hello")).toHaveLength(1);
  });

  it("чужие кадры не мешают: pong, бинарный, не JSON, чужой ответ; второй roster не шлёт запрос заново", () => {
    const r = run(["site@laptop", ...URL_ARG], `${KEY}\nтекст`, "noise");
    expect([r.status, r.stdout]).toEqual([0, "ok\n"]);
    expect(r.prompts).toHaveLength(1);
  });

  it.each([
    ["нет получателя", []],
    ["неизвестный ключ", ["site@laptop", "--zip", "x"]],
    ["--url без адреса", ["site@laptop", "--url"]],
  ])("2082 · вход отклонён: строка вызова, выход 2, relay не звали: %s", (_n, args) => {
    const r = run(args, `${KEY}\nтекст`);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(USAGE);
    expect(r.stdout).toBe("");
    expect(r.frames).toEqual([]);
  });
});

describe("импорт", () => {
  it("2081 · ответа нет за срок: один итог словом, сокет закрыт, по умолчанию настоящий relay", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "switchboard-send-")), "frames.jsonl");
    process.env.FAKE_RELAY = "silent";
    process.env.FAKE_LOG = log;
    await import(FAKE);
    const { send, RELAY } = (await import(pathToFileURL(SEND).href)) as { RELAY: string; send: (cs: string, text: string, o: object) => Promise<{ ok: number; error: string }> };
    expect(RELAY).toBe("wss://relay.pfarm.app");
    expect(await send("site@laptop", "x", { key: KEY, timeoutMs: 100 })).toEqual({ ok: 0, error: "нет ответа за 100 мс" });
    const frames = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(frames[0]).toEqual({ url: `${RELAY}/m/laptop` });
    expect(frames.at(-1)).toEqual({ close: 1000 });
    expect(frames.filter((f) => "close" in f)).toHaveLength(1);
  });
});
