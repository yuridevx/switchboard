// Всё, что модуль знает об API GitHub: адреса, заголовки, предел запроса, статусы, страницы, форма приложения.
// Сбой GitHub — отказ github_failed; статус и текст GitHub идут только в журнал.
import { CALL_MS } from "@switchboard/protocol";
import { Refusal } from "./refusal.ts";

const API = "https://api.github.com";
const WEB = "https://github.com";
const PAGE = 100;

const HEADERS = { accept: "application/vnd.github+json", "user-agent": "switchboard-github", "x-github-api-version": "2022-11-28" };

type Call = { method?: "GET" | "POST"; auth?: string; body?: unknown };

const failed = (why: string, status: number, text: string) => new Refusal("github_failed", why, { journal: { status, text } });

/** Запрос с пределом CALL_MS. Ответа нет — статус 0. */
async function send(path: string, { method = "GET", auth, body }: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { ...HEADERS, ...(auth ? { authorization: auth } : {}), ...(body ? { "content-type": "application/json" } : {}) };
  try {
    return await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(CALL_MS) });
  } catch (e) {
    throw failed(`GitHub недоступен: ${e}`, 0, String(e));
  }
}

async function bodyOf<T>(r: Response, status: number): Promise<T> {
  if (r.status !== status) throw failed(`GitHub ответил ${r.status}`, r.status, await r.text());
  return r.json();
}

/** Список GitHub по страницам, пока страница не короче полной. */
async function everyPage<P, T>(path: string, auth: string, itemsOf: (page: P) => T[]): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const items = itemsOf(await bodyOf<P>(await send(`${path}?per_page=${PAGE}&page=${page}`, { auth }), 200));
    all.push(...items);
    if (items.length < PAGE) return all;
  }
}

const installationToken = (installation: number, auth: string, body: unknown) => send(`/app/installations/${installation}/access_tokens`, { method: "POST", auth, body });

/** Токен установки только к одному репозиторию и только на содержимое. Приложение не допущено к нему — null. */
export async function repoToken(jwt: string, repo: string): Promise<{ token: string; expires_at: string; installation: number } | null> {
  const auth = `Bearer ${jwt}`;
  const found = await send(`/repos/${repo}/installation`, { auth });
  if (found.status === 404) {
    await found.body?.cancel();
    return null;
  }
  const { id } = await bodyOf<{ id: number }>(found, 200);
  const scope = { repositories: [repo.split("/")[1]], permissions: { contents: "write" } };
  const { token, expires_at } = await bodyOf<{ token: string; expires_at: string }>(await installationToken(id, auth, scope), 201);
  return { token, expires_at, installation: id };
}

/** Репозитории всех установок по алфавиту: токен каждой установки только на чтение метаданных. */
export async function installedRepos(jwt: string): Promise<string[]> {
  const auth = `Bearer ${jwt}`;
  const repos: string[] = [];
  for (const { id } of await everyPage("/app/installations", auth, (page: Array<{ id: number }>) => page)) {
    const { token } = await bodyOf<{ token: string }>(await installationToken(id, auth, { permissions: { metadata: "read" } }), 201);
    const list = await everyPage("/installation/repositories", `token ${token}`, (page: { repositories: Array<{ full_name: string }> }) => page.repositories);
    repos.push(...list.map((r) => r.full_name));
  }
  return repos.sort();
}

/** Одноразовый code из возврата GitHub → приложение. client_secret и webhook_secret не нужны: входа через GitHub и вебхуков у флота нет. */
export async function createdApp(code: string): Promise<{ id: number; slug: string; owner: string; pem: string }> {
  const conversion = await send(`/app-manifests/${code}/conversions`, { method: "POST" });
  const { id, slug, owner, pem } = await bodyOf<{ id: number; slug: string; owner?: { login?: string }; pem: string }>(conversion, 201);
  return { id, slug, owner: owner?.login ?? "", pem };
}

export const installUrl = (slug: string) => `${WEB}/apps/${slug}/installations/new`;

/** Форма manifest для браузера пульта: закрытое приложение, содержимое на запись, без вебхуков. */
export function creationForm(redirect: string, org?: string) {
  return {
    action: `${WEB}${org ? `/organizations/${org}` : ""}/settings/apps/new`,
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
  };
}
