// Worker служб v2: без состояния. Вход /call, сервер MCP, проход сокетов в платформу, вебхук Telegram, файлы страницы; потребитель очереди аналитики.
import type { Deps, Env, Module, PointNote } from "./env.ts";
import { callHttp, handlersOf } from "./entrance.ts";
import { analytics, consume } from "./modules/analytics.ts";
import { archive } from "./modules/archive.ts";
import { builds } from "./modules/builds.ts";
import { github } from "./modules/github.ts";
import { keys } from "./modules/keys.ts";
import { ledger } from "./modules/ledger.ts";
import { mcp } from "./modules/mcp.ts";
import { obs } from "./modules/obs.ts";
import { prefs } from "./modules/prefs.ts";
import { reach, telegram } from "./modules/reach.ts";

export { Records } from "./records.ts";

/** Модули служб: у каждого имени запроса один хозяин — двое не соберутся. */
export const MODULES: Module[] = [builds, ledger, archive, reach, prefs, keys, github, analytics, obs];
const handlers = handlersOf(MODULES);

/** Запрос к Worker'у; deps — подмена платформы и сети в тестах. */
export async function serve(req: Request, env: Env, exec: ExecutionContext, deps: Deps = {}): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/call") return callHttp(req, env, exec, handlers, deps);
  if (pathname === "/mcp") return mcp(req, env, exec, handlers, deps);
  if (pathname.startsWith("/f/") || pathname.startsWith("/m/")) return (deps.platform ?? env.PLATFORM).fetch!(req);
  if (pathname === "/telegram" || pathname === "/telegram/setup") return telegram(req, env, exec, deps);
  if (pathname === "/health") return Response.json({ ok: true, part: "services", modules: MODULES.map((m) => m.name) });
  if (env.ASSETS) return env.ASSETS.fetch(req);
  return new Response("switchboard services\n", { status: 404 });
}

export default {
  fetch: (req, env, exec) => serve(req, env, exec),
  queue: (batch, env) => consume(batch as MessageBatch<PointNote>, env),
} satisfies ExportedHandler<Env>;
