// Леса границы «сообщение в сессию от служб компьютера»: настоящий процесс send.mjs и настоящий импорт; поддельный только relay.
// Источник свойства — слово пользователя (устав: «send — сообщение в сессию от служб компьютера ключом клиента, без зависимостей»); без пометки — чьё: код.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SEND = fileURLToPath(new URL("../send.mjs", import.meta.url));
const FAKE = pathToFileURL(fileURLToPath(new URL("./fake-relay.mjs", import.meta.url))).href;
const KEY = "client.alarm.k1a2.sig";
const URL_ARG = ["--url", "wss://relay.test"];
const USAGE = "вызов: <пропуск первой строкой stdin, дальше текст> | node send.mjs <callsign> [--url wss://…]";

type Frame = Record<string, unknown>;

const scratch = () => mkdtempSync(join(tmpdir(), "switchboard-send-"));

function framesOf(log: string): Frame[] {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return []; // relay не звали
  }
}

function fakeEnv(mode: string, log: string, fast: boolean) {
  return { ...process.env, FAKE_RELAY: mode, FAKE_LOG: log, ...(fast ? { FAKE_FAST: "1" } : {}) };
}

function run(args: string[], input: string, mode = "ok", { fast = false, file = SEND, cwd }: { fast?: boolean; file?: string; cwd?: string } = {}) {
  const log = join(scratch(), "frames.jsonl");
  const r = spawnSync(process.execPath, ["--import", FAKE, file, ...args], { input, cwd, encoding: "utf8", env: fakeEnv(mode, log, fast) });
  const frames = framesOf(log);
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
    ["адрес машины: её relay", ["@laptop", ...URL_ARG], "wss://relay.test/m/laptop"],
    ["имя без @ — само себе машина", ["site", ...URL_ARG], "wss://relay.test/m/site"],
    ["после адреса ничего не читается: второй --url не считается", ["site@laptop", "--url", "wss://a.test", "--url", "wss://b.test"], "wss://a.test/m/laptop"],
    ["пустой аргумент вместо ключа — как без него", ["site@laptop", ""], "wss://relay.pfarm.app/m/laptop"],
    ["пустой аргумент и пустой адрес — настоящий relay", ["site@laptop", "", ""], "wss://relay.pfarm.app/m/laptop"],
    ["пустой аргумент и адрес — адрес считается", ["site@laptop", "", "wss://a.test"], "wss://a.test/m/laptop"],
  ])("адрес: %s", (_n, args, url) => {
    expect(run(args, `${KEY}\nтекст`).frames[0]).toEqual({ url });
  });

  it.each([
    ["пробелы и перевод строки Windows вокруг ключа снимаются", `  ${KEY} \r\nтекст`, KEY, "текст"],
    ["метка порядка байт перед ключом снимается", `﻿${KEY}\nтекст`, KEY, "текст"],
    ["текст не обрезается: пустые строки и пробелы целы", `${KEY}\n\n  текст \n`, KEY, "\n  текст \n"],
    ["текст как есть: переводы строк Windows целы", `${KEY}\r\nа\r\nб\r\n`, KEY, "а\r\nб\r\n"],
    ["одна строка — ключ, текст пустой", KEY, KEY, ""],
    ["пустой stdin — решает relay: ключ пустой, текст пустой", "", "", ""],
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

  it.each([
    ["запрос принят, ответа нет", "silent"],
    ["после hello нет roster", "mute"],
    ["соединение не открылось", "deaf"],
  ])("2081 · предел всего разговора: отказ словом, выход 1, сокет закрыт: %s", (_n, mode) => {
    const r = run(["site@laptop", ...URL_ARG], `${KEY}\nтекст`, mode, { fast: true });
    expect([r.status, r.stdout]).toEqual([1, "нет ответа за 30000 мс\n"]);
    expect(r.frames.at(-1)).toEqual({ close: 1000 });
    expect(r.frames.filter((f) => "close" in f)).toHaveLength(1);
  });

  it("relay недоступен: настоящий сокет на закрытый порт — отказ словом, выход 1", () => {
    const r = spawnSync(process.execPath, [SEND, "site@laptop", "--url", "ws://127.0.0.1:9"], { input: `${KEY}\nтекст`, encoding: "utf8" });
    expect([r.status, r.stdout]).toEqual([1, "связь закрыта: 1006 \n"]);
  });

  it("чужие кадры не мешают: pong, бинарный, не JSON, чужой ответ; второй roster не шлёт запрос заново", () => {
    const r = run(["site@laptop", ...URL_ARG], `${KEY}\nтекст`, "noise");
    expect([r.status, r.stdout]).toEqual([0, "ok\n"]);
    expect(r.prompts).toHaveLength(1);
  });

  it.each([
    ["нет получателя", []],
    ["пустой получатель", ["", ...URL_ARG]],
    ["неизвестный ключ", ["site@laptop", "--zip", "x"]],
    ["--url без адреса", ["site@laptop", "--url"]],
    ["--url с пустым адресом", ["site@laptop", "--url", ""]],
    ["--url раньше получателя", [...URL_ARG, "site@laptop"]],
    ["--url=адрес одним словом", ["site@laptop", "--url=wss://relay.test"]],
    ["второй получатель", ["site@laptop", "wiki@pc", ...URL_ARG]],
  ])("2082 · вход отклонён: строка вызова, выход 2, relay не звали: %s", (_n, args) => {
    const r = run(args, `${KEY}\nтекст`);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(USAGE);
    expect(r.stdout).toBe("");
    expect(r.frames).toEqual([]);
  });

  it("запуск по любому пути: папка с пробелом и кириллицей, абсолютный и относительный", () => {
    const dir = join(scratch(), "папка с пробелом");
    mkdirSync(dir);
    const file = join(dir, "send.mjs");
    copyFileSync(SEND, file);
    for (const how of [{ file }, { file: "send.mjs", cwd: dir }]) {
      const r = run(["site@laptop", ...URL_ARG], `${KEY}\nтекст`, "ok", how);
      expect([r.status, r.stdout, r.prompts.length]).toEqual([0, "ok\n", 1]);
    }
  });
});

describe("предел чтения stdin", () => {
  it("stdin не закрыли: отказ словом за предел, выход 1, relay не звали (устав: у всех операций предел)", async () => {
    const log = join(scratch(), "frames.jsonl");
    const c = spawn(process.execPath, ["--import", FAKE, SEND, "site@laptop", ...URL_ARG], { env: fakeEnv("ok", log, true) });
    c.stdin.write(`${KEY}\nтекст`);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    const status = await new Promise((done) => {
      c.on("close", done);
      setTimeout(() => (c.kill(), done("жив через 5 с")), 5000);
    });
    expect([status, out]).toEqual([1, "stdin не закрыт за 30000 мс\n"]);
    expect(existsSync(log)).toBe(false);
  });
});

describe("импорт", () => {
  /** Настоящий импорт в отдельном процессе со своими аргументами: командная строка при импорте не запускается. */
  function imported(mode: string, options: object | undefined, fast = false) {
    const log = join(scratch(), "frames.jsonl");
    const code = `import { send, RELAY } from ${JSON.stringify(pathToFileURL(SEND).href)};
      console.log(JSON.stringify({ RELAY, result: await send("site@laptop", "текст", ${JSON.stringify(options)}) }));`;
    const r = spawnSync(process.execPath, ["--import", FAKE, "--input-type=module", "-e", code, "--", "--zip"], { encoding: "utf8", timeout: 20_000, env: fakeEnv(mode, log, fast) });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    return { ...(JSON.parse(r.stdout) as { RELAY: string; result: unknown }), frames: framesOf(log) };
  }
  const OPTS = { key: KEY };

  it("настоящий relay по умолчанию; успех — { ok: 1, error: \"\" }; итог не держит процесс на предел в минуту", () => {
    const r = imported("ok", { ...OPTS, timeoutMs: 60_000 });
    expect(r.RELAY).toBe("wss://relay.pfarm.app");
    expect(r.result).toEqual({ ok: 1, error: "" });
    expect(r.frames).toEqual([
      { url: `${r.RELAY}/m/laptop` },
      { type: "hello", key: KEY, proto: 1 },
      { type: "session.prompt", v: 1, id: expect.any(String), to: "site@laptop", callsign: "site@laptop", text: "текст" },
      { close: 1000 },
    ]);
  });

  it("параметр url: косая черта в конце снимается", () => {
    expect(imported("ok", { ...OPTS, url: "wss://relay.test/" }).frames[0]).toEqual({ url: "wss://relay.test/m/laptop" });
  });

  it("параметры необязательны: hello без ключа — решает relay", () => {
    const r = imported("ok", undefined);
    expect(r.result).toEqual({ ok: 1, error: "" });
    expect(r.frames[1]).toEqual({ type: "hello", proto: 1 });
  });

  it.each([
    ["Host отказал", "offline", "offline"],
    ["отказ без слова — строка", "wordless", "undefined"],
    ["relay не пустил", "refuse", "связь закрыта: 1008 bad_key"],
    ["связь оборвалась", "drop", "связь закрыта: 1006 "],
  ])("отказ — { ok: 0, error: слово }: %s", (_n, mode, error) => {
    expect(imported(mode, OPTS).result).toEqual({ ok: 0, error });
  });

  it.each([
    ["свой срок", { ...OPTS, timeoutMs: 100 }, false, "нет ответа за 100 мс"],
    ["срок по умолчанию", OPTS, true, "нет ответа за 30000 мс"],
  ])("2081 · ответа нет за срок: один итог словом, сокет закрыт: %s", (_n, options, fast, error) => {
    const r = imported("silent", options, fast);
    expect(r.result).toEqual({ ok: 0, error });
    expect(r.frames.at(-1)).toEqual({ close: 1000 });
    expect(r.frames.filter((f) => "close" in f)).toHaveLength(1);
  });
});
