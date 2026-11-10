// Вход OAuth внешних клиентов MCP (claude.ai, Claude Code): метаданные и /token. Пропуска выдаёт объект флота:
// код — приглашение согласия (его даёт человек со страницы запросом consent), /token — приём приглашения с PKCE, access_token — пропуск устройства.
// Своей регистрации клиентов нет: описание клиента — по его адресу (client_id — URL), его сверяет платформа при согласии.
import { errFields, newId, type Reply } from "@sb/protocol";
import type { Deps, Env } from "./env.ts";
import { log } from "./entrance.ts";

const CORS = { "access-control-allow-origin": "*" };
const MAX_FORM = 8 * 1024;

const json = (body: object, status = 200) => Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
const refused = (error: string, why: string) => {
  log.warn("вход OAuth отказан", { module: "oauth", word: error, why });
  return json({ error, error_description: why }, 400);
};

/** Метаданные сервера входа (RFC 8414). authorization_endpoint — экран согласия страницы: человек входит своим пропуском и разрешает клиенту. */
const server = (origin: string) =>
  json({
    issuer: origin,
    authorization_endpoint: `${origin}/consent`,
    token_endpoint: `${origin}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  });

/** Метаданные ресурса (RFC 9728): где входить, чтобы звать /mcp. */
const resource = (origin: string) => json({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"] });

async function token(req: Request, env: Env, deps: Deps): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_FORM) return refused("invalid_request", "тело больше 8 КБ");
  const form = new URLSearchParams(text);
  const [grant, code, verifier, client, back] = ["grant_type", "code", "code_verifier", "client_id", "redirect_uri"].map((k) => form.get(k) ?? "");
  if (grant !== "authorization_code") return refused("unsupported_grant_type", `grant_type ${grant}`);
  if (!code || !verifier || !client || !back) return refused("invalid_request", "нужны code, code_verifier, client_id и redirect_uri");
  let r: Reply;
  try {
    r = await (deps.platform ?? env.PLATFORM).fleetCall("", null, { type: "redeem", id: newId("r"), trace: newId("t"), invite: code, verifier, client, back });
  } catch (e) {
    log.error("вход OAuth: платформа не ответила", { module: "oauth", ...errFields(e) });
    return json({ error: "server_error", error_description: "платформа не ответила" }, 503);
  }
  // номер кода — в журнал, секрет — нет
  if (!r.ok) return refused("invalid_grant", `код ${code.split(":").slice(0, 2).join(":")} клиента ${client}: ${r.error}`);
  log.info("вход OAuth: пропуск выдан", { module: "oauth", to: (r.result as { addr: string }).addr });
  return json({ access_token: (r.result as { key: string }).key, token_type: "Bearer" });
}

/** Запрос входа OAuth — ответ; остальное — null. */
export function oauth(req: Request, env: Env, deps: Deps): Promise<Response> | Response | null {
  const { pathname, origin } = new URL(req.url);
  const known = pathname === "/token" || pathname.startsWith("/.well-known/oauth-");
  if (!known) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" } });
  if (req.method === "GET" && pathname.startsWith("/.well-known/oauth-authorization-server")) return server(origin);
  if (req.method === "GET" && pathname.startsWith("/.well-known/oauth-protected-resource")) return resource(origin);
  if (req.method === "POST" && pathname === "/token") return token(req, env, deps);
  return new Response(null, { status: 404, headers: CORS });
}
