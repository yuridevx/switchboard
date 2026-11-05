// Всё про GitHub: запрос к API с пределом, JWT приложения, страницы, форма manifest, ссылка установки.
import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { CALL_MS } from "@switchboard/protocol";

/** Отказ словом контракта: reply — поля в ответ, row — только в журнал; why — причина для журнала. */
export class Refusal extends Error {
  word: string;
  reply: Record<string, unknown>;
  row: Record<string, unknown>;
  constructor(word: string, why: string, reply = {}, row = {}) {
    super(why);
    this.word = word;
    this.reply = reply;
    this.row = row;
  }
}

export type Keyed = { id: number; pem: string };
type Answer = { status: number; text: string };

const HEADERS = { accept: "application/vnd.github+json", "user-agent": "switchboard-github", "x-github-api-version": "2022-11-28" };

async function call(method: "GET" | "POST", path: string, auth?: string, body?: object): Promise<Answer> {
  const headers: Record<string, string> = { ...HEADERS };
  if (auth) headers.authorization = auth;
  if (body) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new Refusal("github_failed", `GitHub недоступен: ${e}`, {}, { status: 0 });
  }
}

function json<T>({ status, text }: Answer): T {
  if (status < 200 || status > 299) throw new Refusal("github_failed", `GitHub ответил ${status}`, {}, { status, text });
  return JSON.parse(text) as T;
}

const b64u = (x: object) => Buffer.from(JSON.stringify(x)).toString("base64url");

/** JWT приложения: начало на минуту назад — часы GitHub могут отставать; срок 9 минут вперёд, предел GitHub — 10. */
function jwt({ id, pem }: Keyed): string {
  const iat = Math.floor(Date.now() / 1000) - 60;
  const signed = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iat, exp: iat + 600, iss: String(id) })}`;
  return `Bearer ${signed}.${createSign("RSA-SHA256").update(signed).sign(pem, "base64url")}`;
}

const installationToken = async (id: number, auth: string, body: object) => json<{ token: string; expires_at: string }>(await call("POST", `/app/installations/${id}/access_tokens`, auth, body));

/** Токен только к этому репозиторию и только на содержимое; установки нет — null. */
export async function repoToken(app: Keyed, repo: string) {
  const auth = jwt(app);
  const found = await call("GET", `/repos/${repo}/installation`, auth);
  if (found.status === 404) return null;
  const { id } = json<{ id: number }>(found);
  const { token, expires_at } = await installationToken(id, auth, { repositories: [repo.split("/")[1]], permissions: { contents: "write" } });
  return { installation: id, token, expires_at };
}

/** Все страницы по 100, пока страница не короче. */
async function pages<P, T>(path: string, auth: string, items: (page: P) => T[]): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = items(json<P>(await call("GET", `${path}?per_page=100&page=${page}`, auth)));
    all.push(...got);
    if (got.length < 100) return all;
  }
}

/** Репозитории всех установок приложения по алфавиту. */
export async function allRepos(app: Keyed): Promise<string[]> {
  const auth = jwt(app);
  const repos: string[] = [];
  for (const { id } of await pages("/app/installations", auth, (list: { id: number }[]) => list)) {
    const { token } = await installationToken(id, auth, { permissions: { metadata: "read" } });
    repos.push(...(await pages("/installation/repositories", `token ${token}`, (p: { repositories: { full_name: string }[] }) => p.repositories.map((r) => r.full_name))));
  }
  return repos.sort();
}

/** Одноразовый code из возврата GitHub → приложение с ключом. Остальные секреты ответа не нужны: входа через GitHub и вебхуков у флота нет. Нет владельца — пустая строка. */
export async function convert(code: string) {
  const app = json<{ id: number; slug: string; owner?: { login: string } | null; pem: string }>(await call("POST", `/app-manifests/${code}/conversions`));
  return { id: app.id, slug: app.slug, owner: app.owner?.login ?? "", pem: app.pem };
}

/** Форма для браузера: закрытое приложение с записью содержимого, без вебхуков. */
export const manifestForm = (redirect: string, org?: string) => ({
  action: org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new",
  manifest: {
    name: org ? `Switchboard ${org}` : "Switchboard",
    url: redirect,
    public: false,
    redirect_url: redirect,
    setup_url: redirect,
    hook_attributes: { url: redirect, active: false },
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  },
});

export const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;
