// Вход служб: один для страницы, Host, Keeper, скриптов и сервера MCP. Кадр → кто пришёл → права → схема → исполнение → ответ с отрезком пути.
import {
  CALL_MS, canReach, contract, errFields, fail, type Frame, kindOf, logger, machineOf, MAX_FRAME, ok, parseFrame, parsePass, Refusal, type Reply, type RequestDef,
  stopwatch, type Who, within,
} from "@sb/protocol";
import type { Ctx, Deps, Env, Module } from "./env.ts";
import { note } from "./modules/obs.ts";

export const log = logger("services");

/** Обработчики по имени запроса: у имени один модуль. */
export function handlersOf(modules: Module[]): Map<string, { module: string; run: Module["handlers"][string] }> {
  const all = new Map<string, { module: string; run: Module["handlers"][string] }>();
  for (const m of modules)
    for (const [name, run] of Object.entries(m.handlers)) {
      const def = contract.request(name);
      if (!def || def.target !== "service") throw new Error(`${m.name}: ${name} — не запрос службы в договоре`);
      if (all.has(name)) throw new Error(`${name}: два обработчика — ${all.get(name)!.module} и ${m.name}`);
      all.set(name, { module: m.name, run });
    }
  return all;
}

export interface Caller {
  key: string | null;
  as?: string;
  origin: string;
}

type Handlers = ReturnType<typeof handlersOf>;

/** Права запроса: кто пришёл против пометок договора и машины адресата. */
function allowed(def: RequestDef, who: Who, to: unknown): void {
  if (def.admin && !who.admin) throw new Refusal("forbidden", `${def.name} — только админу флота`);
  if (def.machineOnly && kindOf(who.addr) !== "machine") throw new Refusal("forbidden", `${def.name} — только машине`);
  if (def.target === "session" || def.target === "machine" || def.target === "keeper") {
    const machine = typeof to === "string" ? machineOf(to) : null;
    if (!machine) throw new Refusal("bad_input", "нет адресата to");
    if (!canReach(who, machine)) throw new Refusal("forbidden", `до машины ${machine} вы не достаёте`);
  }
}

/** Один запрос от разобранного кадра до ответа. Отказ — reply со словом; исключение обработчика — module_failed. */
export async function call(env: Env, exec: ExecutionContext, handlers: Handlers, deps: Deps, f: Frame, caller: Caller): Promise<Reply> {
  const lap = stopwatch();
  const id = f.id!;
  const trace = typeof f.trace === "string" && f.trace ? f.trace : id;
  const platform = deps.platform ?? env.PLATFORM;
  let who: Who | null = null;
  let fleet = "";
  let reply: Reply;
  let to: string | undefined;
  try {
    const def = contract.request(f.type);
    if (!def) throw new Refusal("unknown_request", `${f.type} здесь не обслуживается`);
    if (def.open) {
      fleet = parsePass(f.invite)?.fleet ?? "";
      if (!fleet) throw new Refusal("bad_input", "приглашение не того вида");
    } else {
      const pass = parsePass(caller.key);
      if (!pass) throw new Refusal("bad_key", "нет пропуска");
      fleet = pass.fleet;
      const got = await within(platform.who(caller.key!, caller.as), CALL_MS, "платформа не ответила, кто пришёл");
      if ("error" in got) throw new Refusal(got.error, got.why);
      who = got;
    }
    // from и to у запроса службы — поля ввода (период отчёта); отправителя кадра вход ставит сам
    const { type: _t, id: _i, trace: _r, ...fields } = f;
    const parsed = def.input.safeParse(fields);
    if (!parsed.success) throw new Refusal("bad_input", parsed.error.issues.map((i) => `${i.path.join(".") || "ввод"}: ${i.message}`).join("; "));
    const input = parsed.data as Record<string, unknown>;
    to = def.target !== "service" && def.target !== "fleet" && typeof input.to === "string" ? input.to : undefined;
    if (who) allowed(def, who, input.to);
    if (def.target === "service") {
      const h = handlers.get(def.name);
      if (!h) throw new Refusal("unknown_request", `${def.name}: обработчика нет`);
      const ctx: Ctx = {
        env, fleet, who: who!, trace, platform, origin: caller.origin, fetch: deps.fetch ?? fetch,
        log: log.with({ module: h.module, trace, fleet }),
        after: (work) => exec.waitUntil(work.catch((e) => log.error("работа после ответа упала", { module: h.module, trace, fleet, ...errFields(e) }))),
      };
      reply = ok(id, await within(h.run(input, ctx), CALL_MS, `${def.name} не уложился в предел`));
    } else if (def.target === "fleet") {
      reply = await within(platform.fleetCall(fleet, who, { ...input, type: def.name, id, trace }), CALL_MS, "объект флота не ответил");
    } else {
      const r = await within(platform.deliver(fleet, { ...input, type: def.name, id, trace, from: who!.addr }), CALL_MS, "машина не ответила");
      reply = r ?? ok(id);
    }
  } catch (e) {
    if (e instanceof Refusal) reply = fail(id, e.word, e.why);
    else {
      reply = fail(id, "module_failed", e instanceof Error ? e.message : String(e));
      log.error("обработчик упал", { type: f.type, trace, fleet, ...errFields(e) });
    }
  }
  const ms = lap();
  reply = { ...reply, id, trace, spans: [...(reply.spans ?? []), { part: "services", ms }] };
  const from = who?.addr ?? "";
  const line = { type: f.type, trace, fleet, from, to, ms, ok: reply.ok, word: reply.error, why: reply.why };
  if (reply.ok) log.info("запрос", line);
  else log.warn("отказ", line);
  if (fleet && !f.type.startsWith("obs."))
    exec.waitUntil(
      note(env, fleet, { trace, at: Date.now(), type: f.type, from, to, ok: reply.ok, word: reply.error, why: reply.why, ms, spans: reply.spans }, { platform, fetch: deps.fetch ?? fetch, log }).catch((e) =>
        log.error("строка наблюдения не записалась", { trace, fleet, ...errFields(e) }),
      ),
    );
  return reply;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const bearer = (req: Request): string | null => {
  const a = req.headers.get("authorization") ?? "";
  return a.startsWith("Bearer ") ? a.slice(7).trim() : null;
};

/** POST /call: тело — кадр-запрос. Не кадр или кадр без id — 400; остальное — 200 с reply. */
export async function callHttp(req: Request, env: Env, exec: ExecutionContext, handlers: Handlers, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json(fail("", "bad_frame", "нужен POST"), 405);
  const text = await req.text();
  if (text.length > MAX_FRAME) return json(fail("", "too_large", "кадр больше предела"), 413);
  const f = parseFrame(text);
  if (!f || !f.id) return json(fail(f?.id ?? "", "bad_frame", "тело — не кадр с id"), 400);
  return json(await call(env, exec, handlers, deps, f, { key: bearer(req), as: req.headers.get("x-sb-as") ?? undefined, origin: new URL(req.url).origin }));
}
