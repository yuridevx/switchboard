// Разбор истории прогонов CI: node tools/test/history.mjs [сколько последних прогонов — 40]
// Печатает по местам «работ, красных, шагов, красных шагов», ворота слияния и плавающее — шаги и работы,
// у которых на одном и том же коде (дереве) были оба исхода. Плавающее — баг проверки или гонка в продукте: сразу в бэклог.
// Читает GitHub: прогоны и их работы — запросами, файлы журнала шагов (SB2_STEPS, см. tools/fleet/steps.mjs) — `gh run download`.
// Вход в GitHub — тот же, что у gh: токен из GH_TOKEN или из `gh auth token`. Законченный прогон читается один раз: папка в os.tmpdir().
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readSteps } from "../fleet/steps.mjs";
import { render, summarize } from "./summary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const last = Number(process.argv[2] ?? 40);
const CALL_MS = 60_000; // предел одного запроса к GitHub
const run = promisify(execFile);
const token = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim())?.[1];
if (!repo) throw new Error("origin — не репозиторий GitHub");
const cache = path.join(os.tmpdir(), "sb2-history", repo.replace("/", "-"));

async function api(what) {
  const r = await fetch(`https://api.github.com/repos/${repo}/${what}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "sb2-history" }, signal: AbortSignal.timeout(CALL_MS) });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${what}`);
  return r.json();
}

/** Работы, дерево кода и строки шагов одного прогона. */
async function read(r) {
  const dir = path.join(cache, String(r.id));
  const saved = path.join(dir, "run.json");
  if (fs.existsSync(saved)) return JSON.parse(fs.readFileSync(saved, "utf8"));
  fs.mkdirSync(dir, { recursive: true });
  const [jobs, commit, arts] = await Promise.all([api(`actions/runs/${r.id}/jobs?per_page=100`), api(`git/commits/${r.head_sha}`), api(`actions/runs/${r.id}/artifacts?per_page=100`)]);
  const steps = [];
  if (arts.artifacts.some((a) => a.name.startsWith("steps-") && !a.expired)) {
    await run("gh", ["run", "download", String(r.id), "--repo", repo, "--pattern", "steps-*", "--dir", dir], { timeout: 2 * CALL_MS });
    for (const f of fs.readdirSync(dir, { recursive: true })) if (String(f).endsWith(".jsonl")) steps.push(...readSteps(fs.readFileSync(path.join(dir, String(f)), "utf8")));
  }
  const out = { id: r.id, workflow: r.name, event: r.event, tree: commit.tree.sha, conclusion: r.conclusion, created: r.created_at, jobs: jobs.jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })), steps };
  fs.writeFileSync(saved, JSON.stringify(out));
  return out;
}

const listed = [];
for (let page = 1; listed.length < last; page++) {
  const part = (await api(`actions/runs?status=completed&per_page=100&page=${page}`)).workflow_runs;
  listed.push(...part.filter((r) => r.name === "ci" || r.name === "deploy"));
  if (part.length < 100) break;
}
const runs = [];
const queue = listed.slice(0, last);
// прогоны читаются разом, по восемь
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let r; (r = queue.shift()); ) runs.push(await read(r));
}));
runs.sort((a, b) => a.created.localeCompare(b.created));
const day = (s) => s.slice(0, 16).replace("T", " ");
console.log(`прогонов ${runs.length}${runs.length ? ` · ${day(runs[0].created)} — ${day(runs.at(-1).created)} UTC` : ""}`);
console.log(render(summarize(runs)));
