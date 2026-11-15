// Прокси модели на 127.0.0.1: через него идёт каждый запрос claude к модели. Сессия — по x-claude-code-session-id; куда идти и чьим секретом —
// маршрут модуля аккаунтов на каждом вызове. Прокси только везёт вызов: ставит токен аккаунта или ключ провайдера и по слову соседа отдаёт ответ,
// шлёт тот же вызов на следующий аккаунт или ждёт короткую паузу. Правила флота — из ключа proxy.rules настроек флота.
// Тела ответа не читает и переписку не пишет: её пишет сам claude в файл сессии. Недоступный прокси и оборванный поток claude повторяет сам.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PROXY_RULES, prefsGet, READ_MS, Refusal, within } from "@sb/protocol";
import type { Clock } from "../../core/clock.ts";
import type { HostApi, Module } from "../../core/contract.ts";
import type { AccountsApi, Answered, Route } from "../accounts/contract.ts";
import { compile, editRequest, type Rule, type Scope } from "./rules.ts";
import { countTokens, messages, sendJson, anthropicError } from "./muse/handle.ts";
import { museVersion } from "./muse/headers.ts";
import { send } from "./upstream.ts";

type Json = Record<string, any>;
const refuse = (word: string, why?: string) => new Refusal(word, why);

const RULES = PROXY_RULES;
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

/** Заголовки claude к провайдеру: слово-заглушку заменяет настоящий секрет. Токен аккаунта Claude идёт только в Authorization;
 *  ключ провайдера — и в x-api-key, и в Authorization. */
export function headersOf(req: IncomingMessage, route: Pick<Route, "token" | "key">): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const low = name.toLowerCase();
    if (HOP.has(low) || low === "x-api-key" || low === "authorization") continue;
    out[name] = req.rawHeaders[i + 1]!;
  }
  if (route.token !== undefined) return { ...out, authorization: `Bearer ${route.token}` };
  return { ...out, "x-api-key": route.key ?? "", authorization: `Bearer ${route.key ?? ""}` };
}

/** Пауза по часам ядра с обрывом: вызов снят или Host останавливается — ждать больше нечего. */
const sleep = (clock: Clock, ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const t = clock.setTimeout(done, ms);
    signal.addEventListener("abort", () => (clock.clearTimeout(t), fail(new Error("вызов снят во время паузы"))), { once: true });
  });

export function make(): Module {
  let host: HostApi;
  const accounts = () => {
    const api = host.module<AccountsApi>("host-accounts");
    if (!api) throw refuse("no_accounts", "модуля аккаунтов нет в этом Host");
    return api;
  };
  let server: Server;
  let port = 0;
  /** правила флота; null — ещё не прочитаны */
  let rules: ReturnType<typeof compile> | null = null;
  /** список правил флота, как он записан: для проверки на тексте */
  let listed: Rule[] = [];
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
        const r = await within(host.call(prefsGet, { scope: "fleet", prefix: RULES }), READ_MS).catch((e: unknown) => {
          const x = e as Refusal;
          throw refuse("rules_unavailable", `prefs.get ${RULES}: ${x.word ?? "offline"}${x.why ? ` — ${x.why}` : ""}`);
        });
        const list = (r.values[RULES] ?? []) as Rule[];
        if (!Array.isArray(list)) throw refuse("rules_unavailable", `${RULES} — не список правил`);
        const next = compile(list);
        listed = list;
        for (const [name, why] of Object.entries(next.flaws)) host.log.warn("rule", { word: "bad_rule", why: `${name}: ${why} — правило не применяется` });
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

  /** Вызов проверки ключа идёт своим маршрутом; вызов сессии — маршрутом модуля аккаунтов. */
  async function routeOf(sid: string, tried: string[]): Promise<Route> {
    return checks.get(sid) ?? accounts().route(sid, tried);
  }

  /** Ответ провайдера — claude как есть: статус, заголовки, байты. */
  async function pass(up: Awaited<ReturnType<typeof send>>, res: ServerResponse): Promise<void> {
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
    const sid = String(req.headers[SESSION_HEADER] ?? "");
    const acc = checks.has(sid) ? null : accounts();
    /** аккаунты, которые этот вызов уже пробовал: не больше, чем их есть — у соседа кончатся годные */
    const tried: string[] = [];
    /** Маршрут вызова; отказ — ответ сессии словом. */
    const routed = async (): Promise<Route | null> => {
      try {
        return await routeOf(sid, tried);
      } catch (e) {
        const { word, why } = e as { word: string; why?: string };
        host.log.warn("proxy", { word, why: `${sid || "без id сессии"}: ${why ?? word}` });
        // чужому процессу маршрута нет; годных аккаунтов нет — отказ лимита, сессия ждёт сброса; прочее — временно: claude повторит
        if (word === "unknown_session") say(403, "permission_error", word, why);
        else if (word === "no_account") say(429, "rate_limit_error", word, why);
        else say(529, "overloaded_error", word, why);
        return null;
      }
    };
    let route: Route | null = null;
    try {
      const path = req.url ?? "/";
      const body = await readBody(req);
      route = await routed();
      if (!route) return;
      const set = rules ?? (await loadRules().catch((e) => e as Error));
      if (set instanceof Error) {
        const { word, why } = set as unknown as { word: string; why?: string };
        host.log.warn("proxy", { word, why });
        return say(529, "overloaded_error", word, why);
      }
      let anth: Json | null = null;
      let edited = false;
      if (req.method === "POST" && MESSAGES.test(path)) {
        try {
          anth = JSON.parse(body.toString("utf8"));
        } catch {
          return say(400, "invalid_request_error", "bad_json", "тело запроса — не JSON");
        }
        edited = Object.keys(editRequest(anth!, set)).length > 0;
      }
      const model = typeof anth?.model === "string" ? (anth.model as string) : undefined;
      let waited = false;
      for (;;) {
        // побочный вызов сессии провайдера с именем чужой модели уходит на модель сессии
        const foreign = !!route.key && !!route.model && !!anth && anth.model !== route.model;
        if (foreign) anth!.model = route.model;
        const sent = anth && (edited || foreign) ? Buffer.from(JSON.stringify(anth)) : body;
        const seen = (status: number, headers: Answered["headers"], ms: number) => acc?.answer(route!, { status, headers, path, ms, hops: tried.length, waited, ...(model ? { model } : {}) }) ?? ({ act: "pass" } as const);
        const t0 = Date.now();
        if (isMeta(route.to)) {
          if (!anth) return say(404, "not_found_error", "not_supported", `${req.method} ${path}: у Meta только /v1/messages`);
          if (path.startsWith("/v1/messages/count_tokens")) return countTokens(res, anth);
          const creds = { key: route.key ?? "", base: route.to.replace(/\/+$/, ""), version: await muse() };
          await messages(res, anth, creds, ac.signal, (why) => host.log.info("gap", { why: `${sid}: ${why}` }));
          seen(res.statusCode, {}, Date.now() - t0);
          return;
        }
        const up = await send(`${route.to.replace(/\/+$/, "")}${path}`, { method: req.method ?? "GET", headers: headersOf(req, route), body: sent.length ? sent : undefined, signal: ac.signal });
        // время провайдера — до заголовков ответа: у потока это время до первого слова
        const ms = Date.now() - t0;
        host.meter.time("provider", ms);
        if (up.status >= 500 || up.status === 429) host.meter.count("provider.failed");
        const verdict = seen(up.status, up.headers, ms);
        if (verdict.act === "pass") return await pass(up, res);
        // отказ сессии не достаётся: его тело не нужно
        up.body.resume();
        if (verdict.act === "wait") {
          // короткая пауза Claude: тот же вызов на том же аккаунте
          waited = true;
          await sleep(host.clock, verdict.ms, ac.signal);
          continue;
        }
        tried.push(route.account!);
        waited = false;
        acc?.done(route);
        route = null;
        route = await routed();
        if (!route) return;
      }
    } catch (e) {
      const { word, why } = e as { word?: string; why?: string };
      if (word) return say(529, "overloaded_error", word, why);
      if (ac.signal.aborted) return void res.destroy();
      host.meter.count("provider.failed");
      host.log.warn("proxy", { word: "upstream", why: String((e as Error).message ?? e) });
      say(502, "api_error", "upstream", String((e as Error).message ?? e));
    } finally {
      if (route) acc?.done(route);
    }
  }

  /** Проверка ключа: разовый запуск claude через прокси, как у сессии на этом ключе; значение ключа не попадает ни в аргументы, ни в окружение. */
  async function keyCheck(name: string): Promise<{ ok: boolean; word: string }> {
      if (!NAME.test(name)) throw refuse("bad_input", "имя ключа — латиница, цифры, - и _");
    const route = await accounts().keyRoute(name);
    const sid = randomUUID();
    const dir = mkdtempSync(join(host.dataDir, "keycheck-"));
    checks.set(sid, route);
    try {
      const args = ["-p", CHECK_PROMPT, "--output-format", "json", "--no-session-persistence", "--session-id", sid];
      const env = { ...route.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MAX_RETRIES: "0" };
      const { code, out } = await host.cli(args, { env });
      return checked(code, out);
    } finally {
      checks.delete(sid);
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  return {
    // прокси машины — у каждой сессии: адрес провайдера знает route
    name: "host-proxy",
    compose: () => ({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }),
    requests: {
      "key.check": ({ name }: { name: string }) => keyCheck(name),
      /** Проверка правил на тексте: тот же движок, что у запросов к модели. Без rules — правила флота как есть. */
      async "rules.test"({ text, scope = "user", model = "", rules: given }: { text: string; scope?: Scope; model?: string; rules?: Rule[] }) {
        if (!given && !rules) await loadRules();
        const set = compile(given ?? listed);
        const hits: Record<string, number> = {};
        return { after: set.apply(scope, model, text, hits), hits, flaws: set.flaws };
      },
    },
    on: {
      changed(what) {
        if (what !== RULES) return;
        void loadRules().catch((e) => host.log.warn("rule", { word: (e as { word?: string }).word ?? "rules_unavailable", why: `${(e as { why?: string }).why ?? e}: правила прежние` }));
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
      // пробы аккаунтов идут через этот же прокси
      host.module<AccountsApi>("host-accounts")?.proxied(`http://127.0.0.1:${port}`);
      saved.set({ port });
      void muse().catch((e) => host.log.warn("muse_version", { word: "muse_version", why: String((e as { why?: string }).why ?? e) }));
    },
    async stop() {
      server.close();
      server.closeIdleConnections();
      const idle = new Promise<void>((done) => server.once("close", () => done()));
      await within(idle, STOP_MS, "вызовы не кончились").catch(() => {
        host.log.info("proxy_stop", { why: `незаконченных вызовов ${calls.size}: оборваны — claude повторит их` });
      });
      for (const c of calls) c.abort();
      for (const s of sockets) s.destroy();
    },
  };
}
