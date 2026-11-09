// Прокси модели на 127.0.0.1: через него идёт каждый запрос claude к модели. Сессия — по x-claude-code-session-id, куда идти — route у logins
// на каждом вызове (слот может смениться между вызовами), правила флота — из ключа proxy.rules области global у prefs. Переписку не пишет:
// её пишет сам claude в файл сессии. Своих повторов нет: недоступный прокси и оборванный поток claude повторяет сам (замер 9 нояб.).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { refuse, type Host, type Module } from "@switchboard/host";
import { READ_MS, within } from "@switchboard/protocol";
import { compile, editRequest, type Rule } from "@switchboard/rules";
import { countTokens, messages, sendJson, anthropicError } from "./muse/handle.ts";
import { museVersion } from "./muse/headers.ts";
import { send } from "./upstream.ts";

type Json = Record<string, any>;
/** Ответ route у logins: адрес провайдера и ключ флота; у слота-аккаунта ключа нет — вход claude идёт как есть. */
type Route = { to: string; key?: string; env?: Record<string, string>; settings?: Record<string, unknown> };

const RULES = "proxy.rules";
const SESSION_HEADER = "x-claude-code-session-id";
const NAME = /^[A-Za-z0-9_-]+$/;
/** Незаконченным вызовам при остановке: потом обрыв — claude повторит их на новом Host. */
const STOP_MS = 5_000;
/** Запрос и ответ провайдера, которые прокси передаёт: заголовки соединения — своё у каждой стороны. */
const HOP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "content-length", "te", "trailer"]);
const MESSAGES = /^\/v1\/messages(\/count_tokens)?(\?|$)/;
const CHECK_PROMPT = "Ответь одним словом: ok";

/** Перевод протокола нужен провайдеру Meta: у него Responses API, а не Messages. */
const isMeta = (to: string) => /(^|\.)meta\.ai$/.test(new URL(to).hostname);

/** Ответ разового запуска: модель и время или причина словами самого claude. */
function checked(code: number | null, out: string): { ok: boolean; word: string } {
  const line = out.trim().split("\n").at(-1) ?? "";
  try {
    const r = JSON.parse(line) as { is_error?: boolean; result?: string; duration_ms?: number; modelUsage?: Record<string, unknown> };
    if (code !== 0 || r.is_error) return { ok: false, word: r.result ?? `claude вышел с кодом ${code}` };
    return { ok: true, word: `ключ принят, отвечает ${Object.keys(r.modelUsage ?? {})[0] ?? "модель"}, ${r.duration_ms} мс` };
  } catch {
    return { ok: false, word: out.trim().slice(-300) || `claude вышел с кодом ${code}` };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

/** Заголовки claude к провайдеру; у ключа флота слово fleet заменяет ключ — и в x-api-key, и в Authorization, как было у apiKeyHelper. */
function headersOf(req: IncomingMessage, key: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const low = name.toLowerCase();
    if (HOP.has(low) || (key !== undefined && (low === "x-api-key" || low === "authorization"))) continue;
    out[name] = req.rawHeaders[i + 1];
  }
  return key === undefined ? out : { ...out, "x-api-key": key, authorization: `Bearer ${key}` };
}

export function make(): Module {
  let host: Host;
  let server: Server;
  let port = 0;
  /** правила флота; null — ещё не прочитаны */
  let rules: ReturnType<typeof compile> | null = null;
  let loading: Promise<ReturnType<typeof compile>> | null = null;
  let version: Promise<string> | null = null;
  /** идущие проверки ключа: id сессии проверки → маршрут */
  const checks = new Map<string, Route>();
  const sockets = new Set<Socket>();
  const calls = new Set<AbortController>();

  /** Правила флота: один запрос на всех, кто ждёт; ответа нет — отказ, правила прежние. */
  function loadRules(): Promise<ReturnType<typeof compile>> {
    loading ??= (async () => {
      try {
        const r = await host.read("prefs.get", { scope: "global", prefix: RULES });
        if (!r.ok) throw refuse("rules_unavailable", `prefs.get ${RULES}: ${r.error}${r.why ? ` — ${r.why}` : ""}`);
        const list = ((r.result as { values: Record<string, unknown> }).values[RULES] ?? []) as Rule[];
        if (!Array.isArray(list)) throw refuse("rules_unavailable", `${RULES} — не список правил`);
        const next = compile(list);
        for (const [name, why] of Object.entries(next.flaws)) host.log({ kind: "refuse", ev: "rule", word: "bad_rule", why: `${name}: ${why} — правило не применяется` });
        rules = next;
        return next;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /** Версия Muse: один запрос к каналу; не ответил — следующий вызов Meta спросит снова. */
  function muse(): Promise<string> {
    version ??= museVersion(AbortSignal.timeout(READ_MS)).catch((e) => {
      version = null;
      throw refuse("muse_version", String((e as Error).message ?? e));
    });
    return version;
  }

  async function routeOf(sid: string): Promise<Route> {
    const check = checks.get(sid);
    if (check) return check;
    const r = await host.request("route", { sid });
    if (!r.ok) throw refuse(r.error, r.why as string | undefined);
    return r.result as Route;
  }

  /** Тело ответа провайдера — claude как есть: статус, заголовки, байты. */
  async function forward(req: IncomingMessage, res: ServerResponse, url: string, key: string | undefined, body: Buffer, signal: AbortSignal) {
    const up = await send(url, { method: req.method ?? "GET", headers: headersOf(req, key), body: body.length ? body : undefined, signal });
    const headers = Object.fromEntries(Object.entries(up.headers).filter(([k]) => !HOP.has(k)));
    res.writeHead(up.status, headers as Record<string, string | string[]>);
    await new Promise<void>((done) => {
      up.body.on("error", () => res.destroy());
      res.on("close", done);
      up.body.pipe(res);
    });
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ac = new AbortController();
    calls.add(ac);
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
      calls.delete(ac);
    });
    const say = (status: number, type: string, word: string, why?: string) => {
      const e = anthropicError(status, type, why ? `${word}: ${why}` : word);
      if (!res.headersSent) sendJson(res, e.status, e.body);
      else res.destroy();
    };
    try {
      const sid = String(req.headers[SESSION_HEADER] ?? "");
      const path = req.url ?? "/";
      const body = await readBody(req);
      let route: Route;
      try {
        route = await routeOf(sid);
      } catch (e) {
        const { word, why } = e as { word: string; why?: string };
        host.log({ kind: "refuse", ev: "proxy", word, why: `${sid || "без id сессии"}: ${why ?? word}` });
        // чужому процессу маршрута нет; прочее — временно: claude повторит
        return word === "unknown_session" ? say(403, "permission_error", word, why) : say(529, "overloaded_error", word, why);
      }
      const set = rules ?? (await loadRules().catch((e) => e as Error));
      if (set instanceof Error) {
        const { word, why } = set as unknown as { word: string; why?: string };
        host.log({ kind: "refuse", ev: "proxy", word, why });
        return say(529, "overloaded_error", word, why);
      }
      const edits = req.method === "POST" && MESSAGES.test(path);
      let anth: Json | null = null;
      let out = body;
      if (edits) {
        try {
          anth = JSON.parse(body.toString("utf8"));
        } catch {
          return say(400, "invalid_request_error", "bad_json", "тело запроса — не JSON");
        }
        if (Object.keys(editRequest(anth!, set)).length) out = Buffer.from(JSON.stringify(anth));
      }
      if (!isMeta(route.to)) return await forward(req, res, `${route.to.replace(/\/+$/, "")}${path}`, route.key, out, ac.signal);
      if (!anth) return say(404, "not_found_error", "not_supported", `${req.method} ${path}: у Meta только /v1/messages`);
      if (path.startsWith("/v1/messages/count_tokens")) return countTokens(res, anth);
      const creds = { key: route.key ?? "", base: route.to.replace(/\/+$/, ""), version: await muse() };
      await messages(res, anth, creds, ac.signal, (why) => host.log({ ev: "gap", why: `${sid}: ${why}` }));
    } catch (e) {
      const { word, why } = e as { word?: string; why?: string };
      if (word) return say(529, "overloaded_error", word, why);
      host.log({ kind: "refuse", ev: "proxy", word: "upstream", why: String((e as Error).message ?? e) });
      say(502, "api_error", "upstream", String((e as Error).message ?? e));
    }
  }

  /** Проверка ключа: разовый запуск claude через прокси, как у сессии на этом ключе; значение ключа не попадает ни в аргументы, ни в окружение. */
  async function keyCheck(name: string): Promise<{ ok: boolean; word: string }> {
    if (!NAME.test(name)) throw refuse("bad_frame", "имя ключа — латиница, цифры, - и _");
    const r = await host.request("route", { key: name });
    if (!r.ok) throw refuse(r.error, `ключ флота ${name}: ${r.why ?? r.error}`);
    const route = r.result as Route;
    const sid = randomUUID();
    const dir = mkdtempSync(join(host.dataDir, "keycheck-"));
    checks.set(sid, route);
    try {
      const args = ["-p", CHECK_PROMPT, "--output-format", "json", "--no-session-persistence", "--session-id", sid, "--settings", JSON.stringify(route.settings ?? {})];
      const env = { ...route.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_MAX_RETRIES: "0" };
      const { code, out } = await host.cli(args, { env });
      return checked(code, out);
    } finally {
      checks.delete(sid);
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  return {
    // прокси машины — у каждой сессии: адрес провайдера знает route
    session: () => ({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }),
    requests: {
      "machine.key_check": (req) => keyCheck(String(req.name)),
    },
    on: {
      frame(f) {
        if (f.type !== "prefs.changed" || f.name !== RULES) return;
        void loadRules().catch((e) => host.log({ kind: "refuse", ev: "rule", word: (e as { word?: string }).word ?? "rules_unavailable", why: `${(e as { why?: string }).why ?? e}: правила прежние` }));
      },
    },
    /** Порт свой и тот же после перезапуска: процессы claude, которых держатели пережили, идут на прежний адрес. */
    async start(h) {
      host = h;
      const saved = h.store<{ port: number }>();
      server = createServer((req, res) => void serve(req, res));
      server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(saved.get()?.port ?? 0, "127.0.0.1", () => done());
      });
      port = (server.address() as { port: number }).port;
      saved.set({ port });
      void muse().catch((e) => host.log({ kind: "refuse", ev: "muse_version", word: "muse_version", why: String((e as { why?: string }).why ?? e) }));
    },
    async stop() {
      server.close();
      server.closeIdleConnections();
      const idle = new Promise<void>((done) => server.once("close", () => done()));
      await within(idle, "вызовы не кончились", STOP_MS).catch(() => {
        host.log({ ev: "proxy_stop", why: `незаконченных вызовов ${calls.size}: оборваны — claude повторит их` });
      });
      for (const c of calls) c.abort();
      for (const s of sockets) s.destroy();
    },
  };
}
