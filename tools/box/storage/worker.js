// Вход хранилища по подписанным ссылкам для флота в коробке. Бакет настоящий — локальный R2, тот же, что у служб: вход и службы идут в одном процессе.
// Вход стоит первым: запрос по подписанной ссылке к бакету принимает сам, любой другой отдаёт службам как есть.
// Не хватает коробке только этого входа: на флоте файлы, архив и сборки идут по ссылке мимо наших серверов прямо в R2.
// Понимает то, чем пользуются наши части: PUT, GET (диапазон, имя вложения) и HEAD по адресу /<бакет>/<ключ> с подписью SigV4 в запросе.
// Подпись сверяется по-настоящему: ссылка подписывается заново теми же ключами и тем же временем — подписи должны совпасть.
import { AwsV4Signer } from "aws4fetch";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, HEAD", "access-control-allow-headers": "*", "access-control-expose-headers": "etag, content-length, content-range", "access-control-max-age": "3600" };
const refuse = (status, code, why) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${why}</Message></Error>`, { status, headers: { ...CORS, "content-type": "application/xml" } });

/** Чем подпись ссылки не годится; годится — пусто. */
async function unsigned(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const given = q.get("X-Amz-Signature"), date = q.get("X-Amz-Date") ?? "", expires = Number(q.get("X-Amz-Expires"));
  const at = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(date);
  if (!given || !at || !expires) return "в ссылке нет подписи";
  if (Date.now() > Date.UTC(+at[1], +at[2] - 1, +at[3], +at[4], +at[5], +at[6]) + expires * 1000) return "ссылка истекла";
  for (const k of ["X-Amz-Signature", "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-SignedHeaders", "X-Amz-Date"]) q.delete(k);
  const again = await new AwsV4Signer({ method: request.method, url: url.href, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto", signQuery: true, datetime: date }).sign();
  return again.url.searchParams.get("X-Amz-Signature") === given ? "" : "подпись ссылки не сходится";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    // не ссылка в бакет — запрос службам
    if (bucket !== env.FILES_BUCKET || !key || !url.searchParams.has("X-Amz-Signature")) return env.SERVICES.fetch(request);
    const bad = await unsigned(request, env);
    if (bad) return refuse(403, "SignatureDoesNotMatch", bad);
    if (request.method === "PUT") {
      const put = await env.FILES.put(key, request.body);
      return new Response(null, { headers: { ...CORS, etag: put.httpEtag } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return refuse(405, "MethodNotAllowed", request.method);
    const ranged = request.headers.has("range");
    const o = await env.FILES.get(key, ranged ? { range: request.headers } : {});
    if (!o) return refuse(404, "NoSuchKey", `ключа ${key} нет`);
    const headers = new Headers(CORS);
    o.writeHttpMetadata(headers);
    headers.set("etag", o.httpEtag);
    headers.set("accept-ranges", "bytes");
    const attach = url.searchParams.get("response-content-disposition");
    if (attach) headers.set("content-disposition", attach);
    if (ranged && o.range) headers.set("content-range", `bytes ${o.range.offset}-${o.range.offset + o.range.length - 1}/${o.size}`);
    else headers.set("content-length", String(o.size));
    return new Response(request.method === "HEAD" ? null : o.body, { status: ranged && o.range ? 206 : 200, headers });
  },
};
