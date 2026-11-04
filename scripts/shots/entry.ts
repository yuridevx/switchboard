// Настоящий код страниц на подделке relay: большой и малый флот — для снимков глазами. ?app=pult|phone&kind=small|big
import { memoryStore, startApp } from "../../web/packages/core/contract.ts";
import { FakeRelay } from "../../web/packages/core/stand/relay.ts";
import { firstFill } from "../../tools/records/contract.ts";
import { folderOf } from "../../web/packages/ui/contract.ts";
import { PULT, pultParts } from "../../web/pult/stand/parts.ts";
import { phoneParts } from "../../web/phone/stand/parts.ts";
import { fakeBrowser } from "../../web/packages/alerts/stand/fakes.ts";

declare const __HOST__: Record<string, number>;
const q = new URLSearchParams(location.search);
const app = q.get("app") ?? "pult";
const kind = q.get("kind") ?? "small";
const KEY = `client.${app}.k3f1.Qa7sig`;
const ME = "you@mail.ru";

type S = { cs: string; dir: string; state: string; prof: string | null; model: string; effort: string; who: string; parent?: string; q?: string; fail?: string; unread?: string; inc?: string };
type Prof = { about: string; model: string; effort: string; on: Record<string, string>; files?: string[] };

const SMALL: { ms: string[]; prof: Record<string, Prof>; ss: S[] } = {
  ms: ["win", "wsl", "win11-2"],
  prof: {
    ops: { about: "Выкладка, флот и живые проверки", model: "opus", effort: "high", on: { win: "ok", wsl: "ok" } },
    front: { about: "Веб-приложения: пульт и телефон", model: "sonnet", effort: "medium", on: { win: "ok", wsl: "ok", "win11-2": "ok" } },
    reviewer: { about: "Ревью диффа по уставу, без правок", model: "opus", effort: "xhigh", on: { win: "ok", wsl: "conflict" }, files: ["reviewer/memory/notes.md"] },
    bots: { about: "Телеграм-боты pfarm", model: "haiku", effort: "low", on: { "win11-2": "ok" } },
  },
  ss: [
    { cs: "refactor@win", dir: "~/Projects/switchboard", state: "busy", prof: "ops", model: "opus", effort: "high", who: "me" },
    { cs: "tests@wsl", dir: "~/projects/switchboard", state: "idle", prof: "ops", model: "sonnet", effort: "medium", who: "me", parent: "refactor@win", unread: "Все 214 тестов зелёные, эталон 4187 обновлён" },
    { cs: "migrate@win", dir: "~/Projects/switchboard", state: "waiting", prof: "ops", model: "opus", effort: "high", who: "me", q: "Прогнать миграцию D1 на тестовом флоте перед продом?" },
    { cs: "review@wsl", dir: "~/projects/switchboard", state: "idle", prof: "reviewer", model: "opus", effort: "xhigh", who: "me", parent: "refactor@win" },
    { cs: "api@wsl", dir: "~/projects/pfarm", state: "busy", prof: "front", model: "sonnet", effort: "medium", who: "me", inc: "build-red" },
    { cs: "night@wsl", dir: "~/projects/pfarm", state: "failed", prof: "front", model: "sonnet", effort: "medium", who: "me", fail: "слот main: все аккаунты у порога до 16:40" },
    { cs: "bot@win11-2", dir: "C:/work/pfarm", state: "stopped", prof: "bots", model: "haiku", effort: "low", who: "me" },
    { cs: "docs@wsl", dir: "~/projects/pfarm", state: "idle", prof: "front", model: "sonnet", effort: "medium", who: "anna" },
    { cs: "home@win", dir: "~", state: "idle", prof: null, model: "sonnet", effort: "medium", who: "me" },
  ],
};

function bigFleet() {
  let seed = 11;
  const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const shuffle = <T,>(a: T[]) => a.map((x) => [r(), x] as const).sort((p, x) => p[0] - x[0]).map((p) => p[1]);
  const MS = ["win", "wsl", "win11-2", "laptop", "mac-studio", "gpu-01", "gpu-02", "ci-01", "ci-02", "nas", "rog", "office-pc", "dev-anna", "dev-oleg", "hetzner-1", "hetzner-2", "vm-test-1", "vm-test-2", "pi-lab", "build-mac"];
  const live = MS.filter((m) => m !== "laptop" && m !== "vm-test-2");
  const winish = (m: string) => /^(win|rog|office|dev-)/.test(m);
  const PJ = ["switchboard", "pfarm", "homelab", "claude-fleet", "api-gw", "billing", "crm", "landing", "mobile-app", "data-pipe", "ml-ranker", "docs-site", "infra", "terraform", "k8s-charts", "auth", "search", "notify", "payments", "analytics", "admin", "reports", "etl", "scraper", "telegram-bots", "design-sys", "monitoring", "backups", "sandbox", "~"];
  const PF: Array<[string, string, string, string]> = [["ops", "Выкладка, флот и живые проверки", "opus", "high"], ["front", "Веб-приложения: пульт и телефон", "sonnet", "medium"], ["reviewer", "Ревью диффа по уставу, без правок", "opus", "xhigh"], ["bots", "Телеграм-боты", "haiku", "low"], ["infra", "Terraform и кластеры", "opus", "high"], ["data", "Пайплайны данных", "sonnet", "medium"], ["ml", "Обучение и оценка моделей", "opus", "high"], ["qa", "Тесты и прогоны", "sonnet", "low"], ["docs", "Документация", "haiku", "low"], ["sre", "Дежурство и инциденты", "opus", "high"], ["sec", "Аудит безопасности", "opus", "xhigh"], ["mobile", "Мобильное приложение", "sonnet", "medium"], ["api", "API и контракты", "sonnet", "high"], ["db", "Миграции и индексы", "opus", "high"], ["growth", "Лендинги и эксперименты", "sonnet", "medium"], ["billing", "Платежи", "opus", "high"], ["crm", "CRM и интеграции", "sonnet", "medium"], ["search", "Поиск и ранжирование", "opus", "medium"], ["etl", "Выгрузки", "haiku", "medium"], ["design", "Дизайн-система", "sonnet", "medium"], ["perf", "Производительность", "opus", "high"], ["triage", "Разбор входящих", "haiku", "low"]];
  const prof: Record<string, Prof> = {};
  PF.forEach(([id, about, model, effort]) => {
    const on: Record<string, string> = {};
    shuffle(MS).slice(0, 3 + Math.floor(r() * 17)).forEach((m) => (on[m] = "ok"));
    prof[id] = { about, model, effort, on };
  });
  prof.reviewer.on.wsl = "conflict";
  prof.reviewer.files = ["reviewer/memory/notes.md"];
  prof.infra.on["hetzner-1"] = "conflict";
  prof.infra.files = ["infra/skills/plan/SKILL.md"];
  const NAMES = ["fix", "tests", "review", "refactor", "deploy", "docs", "bump", "perf", "audit", "api", "ui", "migrate", "night", "spike", "triage", "e2e", "lint", "schema", "cache", "bot"];
  const Q = ["Выложить на прод сейчас или после ночной проверки?", "Удалить старые таблицы после миграции?", "Поднять версию SDK до 0.3.12?"];
  const FAIL = ["слот main: все аккаунты у порога до 16:40", "профиль не найден в клоне", "папка не существует на машине", "claude не ответил за 60 с"];
  const UNR = ["Готово, PR открыт", "Тесты зелёные", "Нашёл причину: гонка в кэше", "Отчёт в docs/report.md", "Обновил зависимости, сборка прошла"];
  const ss: S[] = [];
  PJ.forEach((p, i) => {
    const pm = shuffle(live).slice(0, 1 + Math.floor(r() * 3));
    const owner = i % 7 === 3 ? "anna" : i % 9 === 5 ? "oleg" : "me";
    const n = 5 + (r() < 0.5 ? 1 : 0);
    let first: S | null = null;
    for (let k = 0; k < n; k++) {
      const m = pm[k % pm.length];
      const dir = p === "~" ? "~" : (winish(m) ? "~/Projects/" : "~/projects/") + p;
      const name = NAMES[(i * 3 + k * 7) % NAMES.length];
      let cs = `${name}@${m}`;
      for (let j = 2; ss.some((s) => s.cs === cs); j++) cs = `${name}-${j}@${m}`;
      const x = r();
      const state = x < 0.06 ? "waiting" : x < 0.1 ? "failed" : x < 0.38 ? "busy" : x < 0.82 ? "idle" : "stopped";
      const pr = Object.keys(prof).filter((id) => prof[id].on[m]);
      const pf = pr.length ? pr[(i + k) % pr.length] : null;
      const s: S = { cs, dir, state, prof: pf, model: pf ? prof[pf].model : "sonnet", effort: pf ? prof[pf].effort : "medium", who: owner };
      if (k > 0 && k % 3 === 0 && first) {
        s.parent = first.cs;
        s.who = first.who;
      }
      if (state === "waiting") s.q = Q[(i + k) % Q.length];
      if (state === "failed") s.fail = FAIL[(i + k) % FAIL.length];
      if (state === "idle" && r() < 0.25) s.unread = UNR[(i + k) % UNR.length];
      ss.push(s);
      first ??= s;
    }
  });
  return { ms: MS, prof, ss };
}

const F = kind === "big" ? bigFleet() : SMALL;
const contract = __HOST__;
const roster = {
  type: "roster" as const,
  machines: F.ms.map((machine) => ({ machine, since: Date.now() - 3600000, proto: 1, contract })),
  sessions: F.ss.map((s) => ({
    callsign: s.cs,
    dir: s.dir,
    state: s.state,
    model: s.model,
    effort: s.effort,
    by: s.who === "me" ? `pult~${ME}` : `laptop~${s.who}@mail.ru`,
    parent: s.parent,
    slot: { name: "main" },
    account: "y0902",
    ...(s.prof ? { profile: { id: `team/profiles/${s.prof}`, state: "ok" } } : {}),
    ...(s.fail ? { failed: { start: s.fail } } : {}),
    ...(s.inc ? { incident: { type: s.inc, key: "switchboard#main", state: "open" } } : {}),
    ...(s.cs === "refactor@win" ? { r2: { at: Date.now() - 60000 } } : {}),
  })),
  clients: [`pult~${ME}`, `phone~${ME}`, "laptop~anna@mail.ru", "laptop~oleg@mail.ru"],
};

const relay = new FakeRelay(roster as never);
(window as unknown as { __relay: FakeRelay }).__relay = relay;
// проекты — запись области флота, как после заполнения при выкладке: папка каждой сессии стала проектом
const TOP = kind === "small" ? ["pfarm", "switchboard"] : ["switchboard", "pfarm"];
relay.scoped.global = { "fleet.projects": firstFill(F.ss.map((s) => ({ callsign: s.cs, folder: folderOf(s.dir) })), TOP) };
if (kind === "small") {
  relay.scoped.global["fleet.labels"] = { machines: { win: "Домашний ПК", wsl: "Ubuntu дома" }, sessions: { "refactor@win": "Переделка списка" } };
  relay.values["web-board.filters"] = [{ id: "f1", name: "pfarm", projects: ["pfarm"] }];
} else {
  relay.values["web-board.filters"] = [
    { id: "f1", name: "GPU", machines: ["gpu-01", "gpu-02"] },
    { id: "f2", name: "Ждут и сбои", states: ["waiting", "failed"] },
    { id: "f3", name: "Дежурство", profiles: ["ops", "sre"], who: ["mine"] },
  ];
}
const h = relay.handlers;
const Q = (s: S) => ({ question: `q-${s.cs}`, kind: "ask", questions: [{ question: s.q, header: "Вопрос", multiSelect: false, options: [{ label: "Да", description: "Выполнить сейчас." }, { label: "Нет, подожди" }] }] });
// запросы разрешения, которые окно снимка поставило само (window.__ask): их помнит и question.list, как настоящий Host
const asks: Array<Record<string, unknown>> = [];
(window as unknown as { __ask(q: Record<string, unknown>): void }).__ask = (q) => {
  asks.push(q);
  relay.push({ type: "session.events", from: q.from, seq: 950 + asks.length, events: [{ type: "assistant", uuid: `perm-${q.question}`, message: { id: `perm-${q.question}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id: q.question, name: q.tool, input: q.input }] } }] });
  relay.push({ type: "question", to: ["pult", "phone"], ...q });
};
h["question.list"] = (f) => ({ ok: true, result: [...F.ss.filter((s) => s.cs === f.callsign && s.q).map(Q), ...asks.filter((q) => q.from === f.callsign)] });
h["answer"] = (f) => {
  const i = asks.findIndex((q) => q.question === f.question);
  if (i >= 0) asks.splice(i, 1);
  return { ok: true };
};
h["session.watch"] = () => ({ ok: true });
h["session.unwatch"] = () => ({ ok: true });
// разговор стенда: что видно в ленте живой сессии
const talk = (cs: string) => {
  const asst = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, message: { id: uuid, model: "claude-opus-5-5", content } });
  const res = (uuid: string, id: string, content: string, is_error = false) => ({ type: "user", uuid, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
  const base = [
    { type: "user", uuid: `${cs}-u1`, timestamp: new Date(Date.now() - 900000).toISOString(), message: { content: `Задача для ${cs}: сборка на CI падает с утра, разбери и почини.` } },
    asst(`${cs}-a1`, [{ type: "thinking", thinking: "Сначала лог CI, потом конфиг тестов." }, { type: "text", text: "Беру. Сначала прочитаю **конфиг** и лог последнего прогона." }]),
    asst(`${cs}-a2`, [{ type: "tool_use", id: `${cs}-t1`, name: "Read", input: { file_path: "vitest.config.ts" } }]),
    res(`${cs}-r1`, `${cs}-t1`, 'export default { test: { testTimeout: 5000 } };'),
    asst(`${cs}-a3`, [{ type: "tool_use", id: `${cs}-t2`, name: "Bash", input: { command: "npm test -- --reporter=dot", description: "Прогон тестов" } }]),
    res(`${cs}-r2`, `${cs}-t2`, "Tests  1 failed | 214 passed\n  эталон 4187: Test timed out in 5000ms", true),
    asst(`${cs}-a4`, [{ type: "tool_use", id: `${cs}-t3`, name: "Edit", input: { file_path: "vitest.config.ts", old_string: "testTimeout: 5000", new_string: "testTimeout: 15000" } }]),
    res(`${cs}-r3`, `${cs}-t3`, "ok"),
    asst(`${cs}-a5`, [{ type: "text", text: "## Итог\n\nСборка падала на **таймауте**: эталон 4187 идёт дольше 5 с.\n\n| Часть | Было | Стало |\n|---|---:|---:|\n| testTimeout | 5 с | 15 с |\n| тесты | 214 из 215 | 215 из 215 |\n\n```ts\nexport default { test: { testTimeout: 15000 } };\n```\n\nОсталось выложить на тестовый флот." }]),
    { type: "result", uuid: `${cs}-z1`, subtype: "success", duration_ms: 134000, num_turns: 6, total_cost_usd: 0.41, usage: { input_tokens: 1200, cache_read_input_tokens: 45000 } },
    { type: "user", uuid: `${cs}-u2`, timestamp: new Date(Date.now() - 120000).toISOString(), message: { content: "Хорошо. Прогони ещё раз и обнови README" } },
  ];
  const running = [
    asst(`${cs}-a6`, [{ type: "tool_use", id: `${cs}-t4`, name: "TodoWrite", input: { todos: [{ content: "Прогнать тесты", status: "completed" }, { content: "Обновить README", activeForm: "Обновляю README", status: "in_progress" }, { content: "Выложить на флот", status: "pending" }] } }]),
    res(`${cs}-r4`, `${cs}-t4`, "ok"),
    asst(`${cs}-a7`, [{ type: "tool_use", id: `${cs}-t5`, name: "Bash", input: { command: "npm run dev", run_in_background: true } }]),
    { type: "system", subtype: "task_started", uuid: `${cs}-k1`, task_id: `${cs}-bg`, tool_use_id: `${cs}-t5`, task_type: "local_bash", description: "npm run dev", is_backgrounded: true },
    res(`${cs}-r5`, `${cs}-t5`, "Command running in background"),
    asst(`${cs}-a8`, [{ type: "tool_use", id: `${cs}-t6`, name: "Agent", input: { description: "Ищет упоминания таймаута", prompt: "Найди все упоминания таймаута в README", subagent_type: "Explore" } }]),
    { type: "system", subtype: "task_started", uuid: `${cs}-k2`, task_id: `${cs}-ag`, tool_use_id: `${cs}-t6`, task_type: "local_agent", description: "Ищет упоминания таймаута" },
    { type: "system", subtype: "task_progress", uuid: `${cs}-k3`, task_id: `${cs}-ag`, summary: "читает README.md", usage: { tool_uses: 3 } },
  ];
  const s = F.ss.find((x) => x.cs === cs);
  if (cs.startsWith("home@")) return [];
  return s?.state === "busy" ? [...base, ...running] : base;
};
h["session.history"] = (f) => ({ ok: true, result: { more: String(f.callsign).startsWith("tests@"), messages: f.before ? [] : talk(String(f.callsign)) } });
h["session.files"] = (f) => ({ ok: true, result: ["src/worker.ts", "src/combat/damage.ts", "test/worker.test.ts", "README.md"].filter((x) => x.includes(String(f.query))) });
h["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
h["session.update"] = () => ({ ok: true, result: {} });
h["session.spec"] = () => ({ ok: true, result: { title: "", mode: "bypassPermissions" } });
h["session.call"] = (f) => {
  const answers: Record<string, unknown> = {
    supportedCommands: [{ name: "compact", description: "Сжать разговор, оставив краткое содержание" }, { name: "context", description: "Сколько занято в контексте" }, { name: "review", description: "Ревью изменений" }, { name: "clear", description: "Начать разговор заново" }],
    getContextUsage: { totalTokens: 84200, maxTokens: 200000, percentage: 42, categories: [{ name: "System prompt", tokens: 3700 }, { name: "System tools", tokens: 21500 }, { name: "Memory files", tokens: 2100 }, { name: "Skills", tokens: 5700 }, { name: "Messages", tokens: 51200 }, { name: "Free space", tokens: 115800 }] },
    supportedAgents: [{ name: "general-purpose", description: "Агент общего назначения для поиска и многошаговых задач" }, { name: "Explore", description: "Быстрый поиск по коду" }],
    rewindFiles: { canRewind: true, filesChanged: ["vitest.config.ts", "README.md"], insertions: 4, deletions: 1 },
    getTaskOutput: { output: "VITE ready in 412 ms\n  Local: http://localhost:5173/\n  ready for changes", total_bytes: 20480, truncated: true },
    cancelAsyncMessage: true,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: { session: { total_cost_usd: 1.84, total_api_duration_ms: 312000, total_lines_added: 148, total_lines_removed: 37 }, rate_limits: { five_hour: { utilization: 34, resets_at: new Date(Date.now() + 7200000).toISOString() }, seven_day: { utilization: 72, resets_at: new Date(Date.now() + 172800000).toISOString() }, seven_day_opus: null } },
    getStatus: { sections: [{ title: "Session", rows: [{ label: "Version", value: "2.1.310" }, { label: "cwd", value: "~/projects/switchboard" }, { label: "Login method", value: "Claude Max" }, { label: "Peer address", value: "скрыт" }] }, { title: "Environment", rows: [{ label: "Model", value: "claude-opus-5-5" }, { label: "MCP servers", value: "2 connected" }] }] },
    getHooksListing: { hooks: [{ event: "PostToolUse", matcher: "Edit|Write", source: "projectSettings", displayText: "cargo fmt" }, { event: "SessionStart", source: "userSettings", displayText: "node ~/hooks/start.mjs" }] },
    mcpServerStatus: [{ name: "github", status: "connected" }, { name: "linear", status: "needs-auth" }, { name: "postgres", status: "failed" }, { name: "figma", status: "disabled" }],
    mcpAuthenticate: { authUrl: "https://example.com/oauth/linear" },
    supportedModels: [{ value: "opus", supportsAutoMode: true }, { value: "sonnet", supportsAutoMode: true }, { value: "haiku" }],
    listPermissionRules: { state: { rules: [{ behavior: "allow", source: "localSettings", rule: "Bash(npm test:*)" }, { behavior: "allow", source: "projectSettings", rule: "Edit(src/**)" }, { behavior: "deny", source: "projectSettings", rule: "Read(.env)" }, { behavior: "ask", source: "userSettings", rule: "WebFetch(domain:example.com)" }] } },
  };
  // режим меняет кадр status, как у настоящего процесса
  if (f.method === "setPermissionMode") {
    relay.push({ type: "session.events", from: f.callsign, seq: 990, events: [{ type: "system", subtype: "status", status: null, uuid: crypto.randomUUID(), permissionMode: (f.args as string[])[0] }] });
    return { ok: true, result: null };
  }
  // вопрос сбоку: «долго» — ответа нет, «нельзя» — отказ, иначе ответ разметкой
  if (f.method === "askSideQuestion") {
    const q = String((f.args as string[])[0]);
    if (q.includes("долго")) return undefined as never;
    if (q.includes("нельзя")) return { ok: false, error: "sdk_error" };
    return { ok: true, result: { response: "На тесте **2.0.0+5**, на проде `2.0.0+3`." } };
  }
  return { ok: true, result: answers[String(f.method)] ?? [] };
};
h["machine.accounts"] = () => ({ ok: true, result: { accounts: { y0902: { login: "ok", email: "dev@mail.ru", plan: "Max 20×", limits: { five_hour: { utilization: 0.42, resetsAt: Date.now() / 1000 + 7200 }, seven_day: { utilization: 0.61, resetsAt: Date.now() / 1000 + 86400 } } }, night: { login: "ok", email: "night@x.io", plan: "Max 5×", limits: { five_hour: { utilization: 0.82, resetsAt: Date.now() / 1000 + 3600 } } } } } });
h["machine.slots"] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] }, second: { account: "night", order: ["night"], wait: Date.now() / 1000 + 3600, sessions: [] } } } });
h["machine.profiles"] = (f) => {
  const m = String(f.machine);
  const profiles: Record<string, unknown> = {};
  let bad: Prof | null = null;
  for (const [id, p] of Object.entries(F.prof)) {
    if (!p.on[m]) continue;
    profiles[`team/profiles/${id}`] = { model: p.model, effort: p.effort, about: p.about };
    if (p.on[m] === "conflict") bad = p;
  }
  return { ok: true, result: { profiles, repos: { "team/profiles": bad ? { state: "conflict", op: "git pull", files: bad.files } : { state: "ok" } } } };
};
h["machine.dirs"] = (f) => {
  const m = String(f.machine);
  const p = String(f.path);
  const kids = new Set<string>();
  for (const s of F.ss) if (s.cs.endsWith(`@${m}`) && s.dir !== p && s.dir.startsWith(`${p}/`)) kids.add(s.dir.slice(p.length + 1).split("/")[0]);
  const depth = p.split("/").length - 1;
  (depth === 0 ? ["Documents", "Downloads", ".config"] : depth === 1 ? ["sandbox", "experiments", "old"] : ["src", "docs", "tests", "scripts", ".git"]).forEach((x) => kids.add(x));
  return { ok: true, result: { path: p, dirs: [...kids].sort() } };
};
h["session.open"] = (f) => {
  const cs = `${f.name}@${f.machine}`;
  if (roster.sessions.some((s) => s.callsign === cs)) return { ok: false, error: "name_taken" };
  roster.sessions.push({ callsign: cs, dir: String(f.dir), state: "idle", model: String(f.model ?? "sonnet"), effort: String(f.effort ?? "medium"), by: `${app}~${ME}`, parent: undefined, slot: { name: "main" }, account: "y0902", ...(f.profile ? { profile: { id: String(f.profile), state: "ok" } } : {}) });
  relay.setRoster({ ...relay.roster, sessions: roster.sessions } as never);
  return { ok: true, result: { callsign: cs } };
};
h["session.r2"] = () => ({ ok: true, result: { point: 1 } });
h["keeper.state"] = (f) => ({ ok: true, result: { keeper: "1.1.3", rev: 9, os: String(f.to).includes("win") ? "windows" : "linux", parts: [{ part: "host", version: "1.2.9+4", state: "running", pid: 4120, restarts: 0 }, { part: "keeper", version: "1.1.3", state: "running" }] } });
h["machine.journal"] = () => ({ ok: true, result: { more: false, records: [{ t: new Date().toISOString(), part: "host", who: "session", kind: "note", ev: "session.open", word: "ok" }, { t: new Date().toISOString(), part: "host", who: "slots", kind: "refuse", ev: "slot.wait", word: "limit", why: "у порога" }] } });
h["ledger.read"] = () => ({ ok: true, result: { more: false, events: [{ id: 1, t: Date.now() - 60000, ev: "machine.joined", from: ".relay", text: "win на связи" }, { id: 2, t: Date.now() - 30000, ev: "session.failed", from: "night@wsl", text: "слот main: все аккаунты у порога" }] } });
h["points.list"] = (f) =>
  f.sid
    ? { ok: true, result: { owner: "win", head: 41, points: [{ id: 41, at: Date.now() - 60000, machine: "win", why: "rule", base: 40, dir: "~/Projects/switchboard", msgs: 212, git: { state: "clean", branch: "main" }, line: true }] } }
    : { ok: true, result: { sessions: [{ sid: "s1", callsign: "refactor@win", dir: "~/Projects/switchboard", owner: "win", head: { id: 41, at: Date.now() - 60000 }, points: 41, branches: 1 }, { sid: "s2", callsign: "old-bot@wsl", dir: "~/old", owner: "wsl", head: { id: 3, at: Date.now() - 86400000 }, points: 3, branches: 0 }], r2: { bytes: 432013312, blocks: 2410 }, sweep: { at: Date.now() - 3600000, blocks: 12, bytes: 10485760 } } };
h["github.app"] = () => ({ ok: true, result: { app: { slug: "switchboard-fleet" }, repos: ["you/switchboard", "team/profiles", "you/site"], install: "https://github.com/apps/x/installations/new" } });
h["releases.list"] = () => ({
  ok: true,
  result: {
    parts: { host: { where: "machine", edge: "1.2.9+4", stable: "1.2.9+4", versions: ["1.2.9+3", "1.2.9+4"] }, keeper: { where: "machine", edge: "1.1.3", stable: "1.1.3", versions: ["1.1.3"] }, pult: { where: "cloud", edge: "1.2.5+2", stable: "1.2.5+2", versions: ["1.2.5+2"] }, relay: { where: "cloud", edge: "1.1.0", stable: "1.1.0", versions: ["1.1.0"] } },
    machines: F.ms.slice(0, 6).map((machine) => ({ machine, plan: {} })),
    rev: 9,
    modules: { "web-board": { into: ["pult", "phone"], built: { pult: "2.0.0", phone: "2.0.0" }, edge: "2.0.0" }, "web-core": { into: ["pult", "phone"], built: { pult: "1.8.0", phone: "1.8.0" }, edge: "1.8.0" } },
  },
});
h["keys.list"] = () => ({ ok: true, result: { passes: [...F.ms.slice(0, 6).map((name, i) => ({ id: `kh${i}`, role: "host", name, person: null, addr: `@${name}`, state: "ok", by: "агент", at: Date.now() - 86400000 })), { id: "kc1", role: "client", name: "pult", person: ME, addr: `pult~${ME}`, state: "ok", by: "@win", at: Date.now() - 86400000 }, { id: "kc2", role: "client", name: "phone", person: ME, addr: `phone~${ME}`, state: "ok", by: `pult~${ME}`, at: Date.now() - 86400000 }] } });

const realFetch = relay.fetch;
const fetchIt = (async (url: string | URL | Request, init?: RequestInit) => {
  const f = JSON.parse(String(init?.body));
  // gate отдаёт машины через стенд; полный список пропусков — обработчик
  if (String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list" && f.role === undefined) return Response.json({ type: "reply", id: f.id, ok: true, result: h["keys.list"]!(f)!.result });
  return realFetch(url, init);
}) as typeof fetch;

const store = memoryStore({ key: KEY });
const run = startApp({
  root: document.getElementById("app")!,
  workers: FakeRelay.WORKERS,
  fetch: fetchIt,
  parts: app === "pult" ? pultParts(fakeBrowser("granted")) : phoneParts(fakeBrowser("granted")),
  store,
  WebSocket: relay.WebSocket,
  platform: { ios: false, standalone: false },
  pauseMs: 50,
  ...(app === "pult" ? PULT : { sections: ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"] }),
});
void run.ready.then(() => {
  // непрочитанное приходит кадрами
  setTimeout(() => {
    for (const s of F.ss) if (s.unread) relay.push({ type: "message", from: s.cs, to: `${app}~${ME}`, text: s.unread });
  }, 50);
});
Object.assign(window, { relay, run });
