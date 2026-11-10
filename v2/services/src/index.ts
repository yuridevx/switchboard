// Worker служб v2: без состояния. Вход /call, сервер MCP и вход OAuth для внешних клиентов, проход сокетов в платформу,
// вебхук Telegram флота (/telegram/<флот>), файлы страницы; потребитель очереди аналитики.
import type { Deps, Env, Module, PointNote } from "./env.ts";
import { callHttp, handlersOf } from "./entrance.ts";
import { oauth } from "./oauth.ts";
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

const CALL_PREFLIGHT = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "authorization, content-type, x-sb-as", "access-control-max-age": "86400" };

/** Запрос к Worker'у; deps — подмена платформы и сети в тестах. */
export async function serve(req: Request, env: Env, exec: ExecutionContext, deps: Deps = {}): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/call") {
    // страница с другого источника (разработка фронта на живом флоте): вход — пропуск в заголовке, куки не используются
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CALL_PREFLIGHT });
    const res = await callHttp(req, env, exec, handlers, deps);
    const out = new Response(res.body, res);
    out.headers.set("access-control-allow-origin", "*");
    return out;
  }
  if (pathname === "/mcp") return mcp(req, env, exec, handlers, deps);
  if (pathname.startsWith("/f/") || pathname.startsWith("/m/")) return (deps.platform ?? env.PLATFORM).fetch(req);
  const entry = oauth(req, env, deps);
  if (entry) return entry;
  if (pathname.startsWith("/telegram/")) return telegram(req, env, exec, deps);
  if (pathname === "/manifest.webmanifest" && env.ASSETS) {
    // Манифест приложения; с приглашением — адрес запуска несёт его, чтобы приложение с экрана «Домой» вошло само
    const invite = new URL(req.url).searchParams.get("invite");
    const res = await env.ASSETS.fetch(new Request(new URL("/manifest.webmanifest", req.url)));
    if (!invite || !res.ok) return res;
    const manifest = (await res.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...manifest, start_url: "/?invite=" + encodeURIComponent(invite) }), { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } });
  }
  if (pathname === "/health") return Response.json({ ok: true, part: "services", modules: MODULES.map((m) => m.name) });
  if (env.ASSETS) return env.ASSETS.fetch(req);
  return new Response("switchboard services\n", { status: 404 });
}

export default {
  fetch: (req, env, exec) => serve(req, env, exec),
  queue: (batch, env) => consume(batch as MessageBatch<PointNote>, env),
} satisfies ExportedHandler<Env>;
