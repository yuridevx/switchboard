// Вход OAuth внешних клиентов MCP (claude.ai, Claude Code): метаданные сервера входа и /token. Выдавать пропуска — дело gate:
// код — приглашение keys.invite согласия пульта, /token — gate.redeem с PKCE, access_token — пропуск устройства. /authorize у gate нет:
// authorization_endpoint — страница согласия пульта. Своей регистрации клиентов нет: описание клиента по адресу (client_id — URL).
import type { Env } from "./index.ts";
import { redeem } from "./passes.ts";

const CORS = { "access-control-allow-origin": "*" };
const MAX_FORM = 8 * 1024;

const json = (body: object, status = 200) => Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
const refused = (error: string, why: string) => {
  console.log(`oauth ${error} · ${why}`);
  return json({ error, error_description: why }, 400);
};

/** Метаданные сервера входа по RFC 8414: issuer — адрес gate. */
const metadata = (origin: string, pult: string) =>
  json({
    issuer: origin,
    authorization_endpoint: pult,
    token_endpoint: `${origin}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  });

async function token(req: Request, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_FORM) return refused("invalid_request", "тело больше 8 КБ");
  const form = new URLSearchParams(text);
  const [grant, code, verifier, client, back] = ["grant_type", "code", "code_verifier", "client_id", "redirect_uri"].map((k) => form.get(k) ?? "");
  if (grant !== "authorization_code") return refused("unsupported_grant_type", `grant_type ${grant}`);
  if (!code || !verifier || !client || !back) return refused("invalid_request", "нужны code, code_verifier, client_id и redirect_uri");
  const r = await redeem(env.DB, code, { verifier, client, back });
  if ("error" in r) return refused("invalid_grant", `код ${code.split(".")[0]} клиента ${client}`);
  return json({ access_token: r.key, token_type: "Bearer" });
}

/** Запрос входа OAuth — ответ; остальное — null, его берёт дверь кадров. */
export function oauth(req: Request, env: Env): Promise<Response> | Response | null {
  const { pathname, origin } = new URL(req.url);
  if (req.method === "OPTIONS" && (pathname === "/token" || pathname.startsWith("/.well-known/")))
    return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
  if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") return metadata(origin, env.PULT);
  if (req.method === "POST" && pathname === "/token") return token(req, env);
  return null;
}
