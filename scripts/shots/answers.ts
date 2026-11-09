// Ответы владельцев на подделке relay: что страница стенда получает на свои запросы. Образцы данных: снимки сравниваются с ними.
import { machineOf } from "@switchboard/protocol";
import { FakeRelay } from "../../web/packages/core/stand/relay.ts";
import type { Fleet, S } from "./fleets.ts";


export function answerRequests(relay: FakeRelay, F: Fleet, roster: { sessions: Array<Record<string, unknown>> }, app: string, ME: string) {
  const h = relay.handlers;
  const Q = (s: S) => ({ question: `q-${s.cs}`, kind: "ask", questions: [{ question: s.q, header: "Вопрос", multiSelect: false, options: [{ label: "Да", description: "Выполнить сейчас." }, { label: "Нет, подожди" }] }] });
  // запросы разрешения, которые окно снимка поставило само (window.__ask): их помнит и question.list, как настоящий Host
  const asks: Array<Record<string, unknown>> = [];
  (window as unknown as { __ask(q: Record<string, unknown>): void }).__ask = (q) => {
    asks.push(q);
    relay.push({ type: "session.events", from: q.from, seq: 950 + asks.length, events: [{ type: "assistant", uuid: `perm-${q.question}`, message: { id: `perm-${q.question}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id: q.question, name: q.tool, input: q.input }] } }] });
    relay.push({ type: "question", to: ["pult", "phone"], ...q });
    relay.setRoster({ ...relay.roster, sessions: relay.roster.sessions.map((x) => (x.callsign === q.from ? { ...x, state: "waiting", mode: q.tool === "ExitPlanMode" ? "plan" : "default" } : x)) } as never);
  };
  h["question.list"] = (f) => ({ ok: true, result: [...F.ss.filter((s) => s.cs === f.callsign && s.q).map(Q), ...asks.filter((q) => q.from === f.callsign)] });
  h["answer"] = (f) => {
    const i = asks.findIndex((q) => q.question === f.question);
    if (i >= 0) {
      relay.setRoster({ ...relay.roster, sessions: relay.roster.sessions.map((x) => (x.callsign === asks[i].from ? { ...x, state: "busy" } : x)) } as never);
      asks.splice(i, 1);
    }
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
  h["session.spec"] = () => ({ ok: true, result: { title: "" } });
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
    // режим меняет поле roster, как на настоящем Host
    if (f.method === "setPermissionMode") {
      const mode = (f.args as string[])[0];
      relay.setRoster({ ...relay.roster, sessions: relay.roster.sessions.map((x) => (x.callsign === f.callsign ? { ...x, mode } : x)) });
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
  h["machine.accounts"] = (f) => {
    const now = Math.floor(Date.now() / 1000);
    const at = now - 20;
    const m = String(f.machine);
    const first = F.ms.indexOf(m) === 0;
    const dev = { login: "ok", plan: "max", limits: { five_hour: { utilization: 0.42, resetsAt: now + 7200, at }, seven_day: { utilization: 0.61, resetsAt: now + 3 * 86400, at } } };
    const night = { login: "ok", plan: "max", limits: { seven_day: { utilization: 1, resetsAt: now + (first ? 86400 : 4 * 86400), at } }, ...(first ? { expires: now + 3 * 86400 } : {}) };
    const spare = { login: "ok", plan: "max", limits: { seven_day: { utilization: 0.03, resetsAt: now + 6 * 86400, at } } };
    const accounts = { "dev@mail.ru": dev, "night@x.io": night, ...(first ? { "spare@x.io": spare, "old@x.io": { login: "none", limits: {} } } : {}) };
    const order = first ? ["dev@mail.ru", "night@x.io", "old@x.io"] : ["dev@mail.ru", "night@x.io"];
    return { ok: true, result: { accounts, slots: { main: { account: "dev@mail.ru", order, wait: null } } } };
  };
  h["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/authorize?code=true" } });
  const REPO = "team/profiles";
  const idOf = (name: string) => `${REPO}/${name}`;
  const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  /** набор стенда: состав в манифесте кусочка */
  const SET = idOf("dev");
  const USE = Object.keys(F.prof).slice(0, 2).map(idOf);
  const namesOf = (name: string) => [{ kind: "skill", name: `${name}-check`, path: `skills/${name}-check/SKILL.md` }, { kind: "agent", name: `${name}-review`, path: `agents/${name}-review.md` }, { kind: "rule", name: `${name}-rules`, path: `.claude/rules/${name}-rules.md` }, { kind: "memory", name: `${name}-note`, path: `memory/${name}-note.md` }];
  h["machine.profiles"] = (f) => {
    const m = String(f.machine);
    const profiles: Record<string, unknown> = {};
    let bad: Prof | null = null;
    for (const [id, p] of Object.entries(F.prof)) {
      if (!p.on[m]) continue;
      profiles[idOf(id)] = { about: p.about, kind: "piece", names: namesOf(id) };
      if (p.on[m] === "conflict") bad = p;
    }
    if (USE.length) profiles[SET] = { about: "моя обычная работа", use: USE, kind: "set", names: [] };
    const at = Date.now() - 120000;
    return { ok: true, result: { profiles, repos: { [REPO]: bad ? { state: "conflict", op: "git pull", files: bad.files, dir: "/data/profiles/team__profiles", at } : { state: "ok", dir: "/data/profiles/team__profiles", at } } } };
  };
  const pieceFiles = (id: string) => {
    const n = nameOf(id);
    if (id === SET) return [{ path: ".claude-plugin/plugin.json", size: 96 }];
    return [{ path: ".claude-plugin/plugin.json", size: 96 }, { path: "CLAUDE.md", size: 1840, head: "Как здесь работаем" }, { path: `.claude/rules/${n}-rules.md`, size: 420, meta: { paths: "src/**" }, head: "Правила кода" }, { path: `skills/${n}-check/SKILL.md`, size: 980, meta: { name: `${n}-check`, description: "проверить перед выкладкой" }, head: "Проверка" }, { path: `skills/${n}-check/steps.md`, size: 310 }, { path: `agents/${n}-review.md`, size: 640, meta: { name: `${n}-review`, description: "ревью изменений", model: "opus" }, head: "Ревью" }, { path: "memory/MEMORY.md", size: 2400 }, ...["feedback", "project", "reference"].map((type, i) => ({ path: `memory/${n}-note${i ? i : ""}.md`, size: 700 + i * 90, meta: { name: `${n} заметка ${i + 1}`, description: "что важно помнить", type } })), { path: "notes.txt", size: 64 }];
  };
  h["profile.view"] = (f) => {
    const chosen = f.profile as string[];
    const expand = (id: string): string[] => (id === SET ? [...USE, SET] : [id]);
    const pieces = [...new Set(chosen.flatMap(expand))];
    const real = pieces.filter((id) => id !== SET);
    const prof = (id: string) => F.prof[nameOf(id)];
    const first = real[0];
    const lost = real.slice(1).map((id) => ({ value: prof(id)?.effort, from: id })).filter((x) => x.value);
    const settings: Record<string, unknown> = {};
    if (first && prof(first)?.model) settings.model = { value: prof(first).model, from: first, lost: [] };
    if (first && prof(first)?.effort) settings.effortLevel = { value: prof(first).effort, from: first, lost };
    if (first) settings["env.MAX_THINKING_TOKENS"] = { value: "8000", from: first, lost: [] };
    const memory = (id: string) => ({ from: id, files: 4, bytes: 3530, indexLines: 12, indexBytes: 2400, types: { feedback: 1, project: 1, reference: 1 } });
    return {
      ok: true,
      result: {
        pieces,
        tree: chosen.map((id) => (id === SET ? { id, set: true, children: USE.map((u) => ({ id: u, set: false })) } : { id, set: false })),
        settings,
        instructions: real.flatMap((id) => [{ from: id, path: "CLAUDE.md", head: "Как здесь работаем", rule: false }, { from: id, path: `.claude/rules/${nameOf(id)}-rules.md`, head: "Правила кода", rule: true, paths: "src/**" }]),
        skills: real.map((id) => ({ from: id, name: `${nameOf(id)}:${nameOf(id)}-check`, description: "проверить перед выкладкой", path: `skills/${nameOf(id)}-check/SKILL.md`, extra: [`skills/${nameOf(id)}-check/steps.md`] })),
        agents: real.map((id) => ({ from: id, name: `${nameOf(id)}:${nameOf(id)}-review`, description: "ревью изменений", path: `agents/${nameOf(id)}-review.md`, model: "opus", main: false })),
        memory: { ...(real.length ? { home: memory(real.at(-1)!) } : {}), near: real.slice(0, -1).map(memory) },
        prompt: {},
        mcp: real.length ? [{ from: real[0], kind: "server", name: "grafana", detail: "npx grafana-mcp", config: { command: "npx", args: ["grafana-mcp"] } }] : [],
        other: real.map((id) => ({ from: id, path: "notes.txt" })),
        files: Object.fromEntries(pieces.map((id) => [id, pieceFiles(id)])),
      },
    };
  };
  h["profile.file"] = (f) => {
    const path = String(f.path);
    const id = String(f.id);
    if (path.endsWith("plugin.json")) return { ok: true, result: { text: JSON.stringify({ name: nameOf(id), description: F.prof[nameOf(id)]?.about ?? "моя обычная работа", ...(id === SET ? { metadata: { use: USE } } : {}) }) } };
    return { ok: true, result: { text: `# ${path}\n\nТекст файла кусочка ${nameOf(id)}.` } };
  };
  h["fleet.prompt"] = () => ({ ok: true, result: { text: "Ты сессия флота: инструменты list, send, answer, open, history." } });
  const keys: Record<string, { env: Record<string, string>; settings: Record<string, unknown> }> = {
    orca: { env: { ANTHROPIC_BASE_URL: "https://api.orcarouter.ai", ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus", ANTHROPIC_DEFAULT_SONNET_MODEL: "orcarouter/auto", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }, settings: {} },
    kimi: { env: { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic", ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2", CLAUDE_CODE_DISABLE_THINKING: "1" }, settings: { modelOverrides: { "claude-opus-5-5": "kimi-k2" } } },
  };
  h["fleetkeys.list"] = () => ({ ok: true, result: { keys } });
  h["fleetkeys.set"] = (f) => {
    keys[String(f.name)] = { env: f.env as Record<string, string>, settings: (f.settings ?? {}) as Record<string, unknown> };
    return { ok: true };
  };
  h["fleetkeys.remove"] = (f) => {
    if (!keys[String(f.name)]) return { ok: false, error: "no_key" };
    delete keys[String(f.name)];
    return { ok: true };
  };
  h["machine.key_check"] = (f) => (f.name === "kimi" ? { ok: true, result: { ok: false, word: "адрес отвечает, но ключ не принят: 401" } } : { ok: true, result: { ok: true, word: "ключ принят, отвечает anthropic/claude-opus, 412 мс" } });
  h["machine.dirs"] = (f) => {
    const m = String(f.machine);
    const p = String(f.path);
    const kids = new Set<string>();
    for (const s of F.ss) if (machineOf(s.cs) === m && s.dir !== p && s.dir.startsWith(`${p}/`)) kids.add(s.dir.slice(p.length + 1).split("/")[0]);
    const depth = p.split("/").length - 1;
    (depth === 0 ? ["Documents", "Downloads", ".config"] : depth === 1 ? ["sandbox", "experiments", "old"] : ["src", "docs", "tests", "scripts", ".git"]).forEach((x) => kids.add(x));
    return { ok: true, result: { path: p, dirs: [...kids].sort() } };
  };
  h["session.open"] = (f) => {
    if (typeof f.wing_of === "string") {
      const lead = roster.sessions.find((s) => s.callsign === f.wing_of);
      if (!lead) return { ok: false, error: "offline" };
      if (roster.sessions.some((s) => s.wing === true && s.parent === lead.callsign)) return { ok: false, error: "has_wing" };
      const wing = `${String(lead.callsign).split("@")[0]}-wing@${f.machine}`;
      roster.sessions.push({ ...lead, callsign: wing, parent: lead.callsign, wing: true, model: String(f.model ?? lead.model), effort: String(f.effort ?? lead.effort), profile: ((f.profile ?? []) as string[]).map((id) => ({ id, state: "ok" })), slot: { name: String(f.slot ?? "main") } });
      relay.setRoster({ ...relay.roster, sessions: roster.sessions } as never);
      return { ok: true, result: { callsign: wing } };
    }
    const cs = `${f.name}@${f.machine}`;
    if (roster.sessions.some((s) => s.callsign === cs)) return { ok: false, error: "name_taken" };
    roster.sessions.push({ callsign: cs, dir: String(f.dir), state: "idle", model: String(f.model ?? "sonnet"), effort: String(f.effort ?? "medium"), by: `${app}~${ME}`, parent: undefined, slot: { name: "main" }, account: "dev@mail.ru", ...(f.profile ? { profile: { id: String(f.profile), state: "ok" } } : {}) });
    relay.setRoster({ ...relay.roster, sessions: roster.sessions } as never);
    return { ok: true, result: { callsign: cs } };
  };
  h["session.r2"] = () => ({ ok: true, result: { point: 1 } });
  h["keeper.state"] = (f) => ({ ok: true, result: { keeper: "1.1.3", rev: 9, os: String(f.to).includes("win") ? "windows" : "linux", parts: [{ part: "host", version: "1.2.9+4", state: "running", pid: 4120, restarts: 0 }, { part: "keeper", version: "1.1.3", state: "running" }] } });
  h["machine.journal"] = () => ({ ok: true, result: { more: false, records: [{ t: new Date().toISOString(), part: "host", who: "session", kind: "note", ev: "session.open", word: "ok" }, { t: new Date().toISOString(), part: "host", who: "slots", kind: "refuse", ev: "slot.wait", word: "limit", why: "у порога" }] } });
  h["ledger.read"] = () => ({ ok: true, result: { more: false, events: [{ id: 2, t: Date.now() - 30000, ev: "session.failed", from: "night@wsl", text: "слот main: все аккаунты у порога" }, { id: 1, t: Date.now() - 60000, ev: "machine.joined", from: ".relay", text: "win на связи" }] } });
  h["points.list"] = (f) =>
    f.sid
      ? { ok: true, result: { owner: "win", head: 41, points: [{ id: 41, at: Date.now() - 60000, machine: "win", why: "rule", base: 40, dir: "~/Projects/switchboard", msgs: 212, git: { state: "clean", branch: "main" }, line: true }] } }
      : { ok: true, result: { sessions: [{ sid: "s1", callsign: "refactor@win", dir: "~/Projects/switchboard", owner: "win", head: { id: 41, at: Date.now() - 60000 }, points: 41, branches: 1 }, { sid: "s2", callsign: "old-bot@wsl", dir: "~/old", owner: "wsl", head: { id: 3, at: Date.now() - 86400000 }, points: 3, branches: 0 }], r2: { bytes: 432013312, blocks: 2410 }, sweep: { at: Date.now() - 3600000, blocks: 12, bytes: 10485760 } } };
  // вызов модели из архива для проверки правил прокси
  const system = ["You are Claude Code, Anthropic's official CLI for Claude.", "You are a Claude agent, built on Anthropic's Claude Agent SDK.", "# Tone and style\nYour responses should be short and concise."].join("\n\n");
  h["points.history"] = () => ({ ok: true, result: { point: 41, more: false, messages: [{ type: "user", uuid: "u1", message: { content: "Перенеси журнал в ClickHouse, ticket OPS-12" } }], calls: [{ uuid: "u2", at: new Date(Date.now() - 3600000).toISOString(), model: "claude-opus-5-5", tok_in: 18000, tok_out: 420, system }] } });
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
}
