// GitHub для флота в коробке. Git — настоящий: репозиторий кусочков лежит на диске коробки, машины клонируют и отправляют как обычно —
// адрес https://github.com/ подменяет настройка самого git (insteadOf) в его общем файле настроек, который коробка даёт машинам.
// Токены приложения GitHub на раннере не получить, поэтому пять запросов API о них отвечает двойник; подпись приложения он сверяет по-настоящему.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Репозиторий кусочков коробки: владелец/имя, как на GitHub. */
export const REPO = "box/pieces";
/** Что в нём лежит: кусочек reviewer — ставит модель и несёт один скил; его ищут проверки «Новой сессии» и второй машины.
 *  Кусочек notes — с памятью: индекс и одна запись; его ищет проверка «память флота». */
const FILES = {
  "notes/.claude-plugin/plugin.json": JSON.stringify({ name: "notes", description: "Память проекта" }, null, 2),
  "notes/memory/MEMORY.md": "- [Сборка](build.md) — как собирается проект\n",
  "notes/memory/build.md": "Проект собирается одной командой.\n",
  "reviewer/.claude-plugin/plugin.json": JSON.stringify({ name: "reviewer", description: "Ревью изменений" }, null, 2),
  "reviewer/settings.json": JSON.stringify({ model: "claude-opus-5-5" }, null, 2),
  "reviewer/skills/review/SKILL.md": "---\nname: review\ndescription: Пройтись по изменениям и назвать находки\n---\n\nПрочитай дифф и назови находки по убыванию важности.\n",
  "base/.claude-plugin/plugin.json": JSON.stringify({ name: "base", description: "Общие правила" }, null, 2),
  "base/CLAUDE.md": "Отвечай коротко.\n",
};

/** Голый репозиторий коробки на её диске. */
const bare = (state) => path.join(state, "git", REPO + ".git");

/** Голый репозиторий на диске и файл общих настроек git с подменой адреса. Ответ — путь к файлу настроек: его получают машины в GIT_CONFIG_GLOBAL.
 *  extra — файлы сверх кусочков: определение фабрики проекта коробки, его собирает сама коробка. */
export function seed(state, extra = {}) {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "box", GIT_AUTHOR_EMAIL: "box@switchboard", GIT_COMMITTER_NAME: "box", GIT_COMMITTER_EMAIL: "box@switchboard" } });
  const work = path.join(state, "git-seed"), served = path.join(state, "git");
  for (const [file, body] of Object.entries({ ...FILES, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), body);
  }
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "кусочки коробки");
  fs.mkdirSync(path.join(served, path.dirname(REPO)), { recursive: true });
  git(state, "clone", "-q", "--bare", work, path.join(served, REPO + ".git"));
  const config = path.join(state, "gitconfig");
  fs.writeFileSync(config, `[url "${pathToFileURL(served).href}/"]\n\tinsteadOf = https://github.com/\n[safe]\n\tdirectory = *\n[receive]\n\tdenyCurrentBranch = ignore\n`);
  return config;
}

/** Двойник API GitHub: создание приложения, установки, токены; голова основной ветки и файл на ней — из настоящего репозитория коробки (state — её папка).
 *  log — строка на запрос. */
export function serve(port, log = () => {}, state = "") {
  const git = (...args) => execFileSync("git", ["--git-dir", bare(state), ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const APP = 1, INSTALL = 7;
  /** Секрет подписи событий приложения: GitHub называет его один раз — в ответе на создание приложения. */
  const SECRET = crypto.randomBytes(20).toString("hex");
  /** Подпись приложения в Authorization: Bearer <JWT RS256> — сверяется ключом, который двойник выдал при создании приложения. */
  const signedByApp = (req) => {
    const [head, body, sign] = (/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "").split(".");
    if (!sign) return false;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    return claims.iss === String(APP) && claims.exp * 1000 > Date.now() && crypto.createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, sign, "base64url");
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://github.box");
    const send = (status, body) => (log(`${req.method} ${url.pathname} → ${status}`), res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)));
    if (req.method === "POST" && /^\/app-manifests\/[\w-]+\/conversions$/.test(url.pathname)) return send(201, { id: APP, slug: "switchboard-box", owner: { login: "box" }, pem: privateKey.export({ type: "pkcs1", format: "pem" }), webhook_secret: SECRET });
    const token = /^token (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (req.method === "GET" && url.pathname === "/installation/repositories") return token?.startsWith("ghs_box_") ? send(200, { repositories: [{ full_name: REPO }] }) : send(401, { message: "Bad credentials" });
    // чтение репозитория токеном установки: голова основной ветки и файл на названном коммите
    if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/commits/`) && token?.startsWith("ghs_box_")) return send(200, { sha: git("rev-parse", url.pathname.split("/").pop()).trim() });
    if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/contents/`) && token?.startsWith("ghs_box_")) {
      const file = decodeURIComponent(url.pathname.slice(`/repos/${REPO}/contents/`.length));
      try {
        return send(200, { path: file, encoding: "base64", content: Buffer.from(git("show", `${url.searchParams.get("ref") ?? "HEAD"}:${file}`)).toString("base64") });
      } catch {
        return send(404, { message: "Not Found" });
      }
    }
    if (!signedByApp(req)) return send(401, { message: "A JSON web token could not be decoded" });
    if (req.method === "GET" && url.pathname === "/app/installations") return send(200, [{ id: INSTALL }]);
    if (req.method === "GET" && url.pathname === `/repos/${REPO}/installation`) return send(200, { id: INSTALL });
    if (req.method === "POST" && url.pathname === `/app/installations/${INSTALL}/access_tokens`) return send(201, { token: "ghs_box_" + crypto.randomBytes(8).toString("hex"), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    send(404, { message: "Not Found" });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}
