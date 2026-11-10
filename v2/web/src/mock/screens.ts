// Мок флота — запросы экранов (кроме разговора): пропуска и люди, аккаунты, профили, архив, инциденты, правила прокси, связь с людьми, наблюдение.
// Формы — те же, что в договоре после первой волны итерации. Подключается одной строкой в fleet.ts: обработчики ложатся поверх прежних.
import {
  type Account, type ArchPoint, type ArchSession, type DeviceRow, type Frame, type Incident, type KeyRow, type LedgerEvent, type MachineRow, type ObsRow, type PassRow,
  type PersonRow, type Piece, type Project, type ProxyRule, type RepoClone, type SessionRow, machineOf, newId, Refusal,
} from "@sb/protocol";

type Ev = Record<string, any>;
export type MockCtx = {
  now: () => number; T: number; ME: string; MY_ADDR: string;
  machines: Record<string, MachineRow>; sessions: Record<string, SessionRow>; people: PersonRow[]; projects: Project[]; passes: PassRow[]; devices: DeviceRow[];
  keys: KeyRow[]; accounts: Record<string, Account[]>; pieces: Piece[]; archive: ArchSession[]; incidents: Record<string, Incident[]>;
  prefs: Record<"me" | "fleet", Record<string, unknown>>; ledger: LedgerEvent[]; obs: ObsRow[];
  archPoints: (s: ArchSession) => ArchPoint[]; journal: (machine: string) => Array<{ t: number; part: string; level: "info" | "warn" | "error"; msg: string; machine: string; trace: string }>;
  talk: (c: string) => Ev[]; talks: Map<string, Ev[]>;
  need: <T>(v: T | undefined, why: string) => T; mach: (f: Frame) => string; sess: (f: Frame) => { c: string; s: SessionRow };
  delta: (d: object) => void; setRow: (c: string, patch: Partial<SessionRow> | null) => void;
  row: (callsign: string, state: SessionRow["state"], project: string | undefined, r?: Record<string, unknown>) => SessionRow;
};

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** Проверка правил на тексте — упрощённый движок мока: буквальный текст и регулярка, замена или удаление совпадения, строки, абзаца, блока. */
export function applyRules(text: string, rules: Array<Partial<ProxyRule> & { name: string }>, scope = "user", model = ""): { after: string; hits: Record<string, number>; flaws: Record<string, string> } {
  const hits: Record<string, number> = {}, flaws: Record<string, string> = {};
  let after = text;
  for (const r of rules) {
    if (r.on === false) continue;
    if (!r.pattern) { flaws[r.name] = "нечего искать"; continue; }
    if (r.scopes?.length && !r.scopes.includes(scope as never)) continue;
    if (r.models?.length && !r.models.some((m) => new RegExp("^" + m.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(model))) continue;
    let re: RegExp;
    try {
      re = new RegExp(r.kind === "regex" ? r.pattern : r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g" + (r.icase ? "i" : ""));
    } catch (e) {
      flaws[r.name] = "выражение не разобрано: " + (e as Error).message;
      continue;
    }
    const to = r.action === "delete" ? "" : r.replacement ?? "";
    const unit = r.unit ?? "match";
    let n = 0;
    if (unit === "match") after = after.replace(re, (...a) => (n++, r.kind === "regex" ? to.replace(/\$(\d)/g, (_, i) => a[Number(i)] ?? "") : to));
    else if (unit === "block") { if (re.test(after)) (n = 1, after = to); }
    else {
      const sep = unit === "line" ? "\n" : "\n\n";
      after = after.split(sep).flatMap((part) => (new RegExp(re.source, re.flags.replace("g", "")).test(part) ? (n++, r.action === "delete" ? [] : [to]) : [part])).join(sep);
    }
    hits[r.name] = n;
  }
  return { after, hits, flaws };
}

export function screenHandlers(c: MockCtx): Record<string, (f: any) => unknown> {
  const { now, T, ME, MY_ADDR, machines, sessions, people, projects, passes, devices, keys, accounts, pieces, archive, incidents, prefs, ledger, obs } = c;
  const online = (m: string) => machines[m]?.online === true;

  /* ===== Данные в формах договора ===== */
  for (const p of passes) {
    p.by = p.addr === "pult" + ME ? undefined : p.person === ME ? MY_ADDR : MY_ADDR;
    p.online = !p.wait && (p.addr.startsWith("@") ? online(p.addr.slice(1)) : p.addr === MY_ADDR || (p.seen ?? 0) > T - 30 * MIN);
  }
  const devicesOf = (person: string) => passes.filter((p) => p.person === person).map((p) => ({ kid: p.kid, addr: p.addr, wait: p.wait, online: !!p.online, at: p.at, ...(p.seen ? { seen: p.seen } : {}) }));
  accounts.laptop[0] = { ...accounts.laptop[0], current: true };
  accounts.laptop[1] = { ...accounts.laptop[1], wait: T + 2 * HOUR };
  accounts.server[0] = { ...accounts.server[0], current: true };
  accounts.server.push({ id: "night@example.com", kind: "claude", email: "night@example.com", plan: "Max 5x", limits: [{ name: "five_hour", used: 0.02, resets: T + 4 * HOUR }, { name: "seven_day", used: 0.11, resets: T + 5 * DAY }], ok: true, sessions: 0 });
  accounts["anya-pc"][0] = { ...accounts["anya-pc"][0], current: true };
  for (const list of Object.values(accounts)) for (const a of list) if (a.kind === "key") Object.assign(a, { provider: "openai-compatible", base: "https://api.orca.example/v1", model: "glm-abliterated" });
  Object.assign(keys[0], { models: { "claude-fable-5-2": "glm-5.3", "claude-haiku-5-5": "glm-5.3-flash" }, window: 128_000, env: { DISABLE_TELEMETRY: "1" }, sessions: 0 });
  Object.assign(keys[1], { sessions: 1 });
  for (const a of archive) Object.assign(a, { live: !!sessions[a.callsign] && sessions[a.callsign].state !== "stopped", owner: machines[a.machine]?.owner ?? ME });
  incidents.server.push({ id: "i4", kind: "backup", key: "nightly", text: "Ночная копия не снята: том /backup не подключён", at: T - 70 * MIN, state: "pending", why: "вида backup нет в правилах: сессию открыть некому", files: ["backup.log"] });
  const repos: Record<string, RepoClone[]> = {
    laptop: [
      { repo: "example/sb-base", state: "ok", dir: "~/.switchboard2/home/host/data/profiles/example--sb-base", at: T - 40_000 },
      { repo: "example/sb-web", state: "ok", at: T - 40_000 },
      { repo: "example/sb-ops", state: "conflict", op: "merge", files: ["skills/deploy/SKILL.md"], at: T - 2 * HOUR },
      { repo: "example/sb-research", state: "error", op: "clone", error: "нет доступа у приложения GitHub", at: T - 3 * HOUR },
    ],
  };
  Object.assign(prefs.fleet, {
    "proxy.rules": [
      { name: "Внутренние адреса", on: true, scopes: ["user", "tool_result"], kind: "literal", unit: "match", action: "replace", pattern: "internal.example.com", replacement: "example.com" },
      { name: "Имена клиентов", on: true, scopes: ["user", "assistant", "tool_result"], kind: "regex", unit: "match", action: "replace", pattern: "ООО «[^»]+»", replacement: "ООО «Клиент»" },
      { name: "Номера карт", on: false, scopes: ["user", "tool_result"], kind: "regex", unit: "line", action: "delete", pattern: "\\b\\d{4} \\d{4} \\d{4} \\d{4}\\b", models: ["glm-*"] },
    ] satisfies ProxyRule[],
    "incidents.kinds": {
      disk: { cwd: "~/ops", pieces: ["base", "ops"], prompt: "Разберись, что заняло место, и предложи, что убрать.", notify: [ME] },
      cert: { cwd: "~/ops", pieces: ["base", "ops"], machines: ["server"] },
    },
    "profiles.repos": ["example/sb-base", "example/sb-web", "example/sb-ops", "example/sb-research"],
    prices: { "claude-fable": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, glm: { input: 0.6, output: 2.2 } },
    "obs.alerts": { rate: 0.25, min: 20 },
  });
  let bot: { bot: string; on: boolean } = { bot: "switchboard_fleet_bot", on: true };
  const reports: Array<{ at: number; part: string; level: string; msg: string; who: string }> = [{ at: T - 26 * MIN, part: "host", level: "error", msg: "host-profiles: сведение example/sb-research не прошло: нет доступа", who: "@laptop" }];

  const folderCheck = (cwd: string, machine: string) => {
    const dir = cwd || "~/projects/site";
    const shared = Object.values(sessions).filter((s) => machineOf(s.callsign) === machine && s.spec.cwd === dir && s.state !== "stopped").map((s) => s.callsign);
    const folder = /nope|other/.test(dir) ? "other" : /new|empty/.test(dir) ? "empty" : shared.length ? "shared" : /dirty/.test(dir) ? "dirty" : "same";
    return { folder, dir, files: folder === "dirty" ? 3 : 0, branch: "sb/point" as string | null, sessions: folder === "shared" ? shared : [] };
  };

  return {
    /* пропуска и люди */
    invite: (f) => {
      const person = f.owner ?? (String(f.addr).includes("~") ? "~" + String(f.addr).split("~")[1] : ME);
      if (f.fresh && people.some((p) => p.person === person)) throw new Refusal("exists", `${person.slice(1)} уже во флоте`);
      if (!people.some((p) => p.person === person)) people.push({ person, admin: false, projects: [], at: now() });
      const kid = "k" + newId().slice(0, 6);
      passes.unshift({ kid, addr: f.addr, person, wait: true, at: now(), by: MY_ADDR, online: false });
      return { kid, invite: `home:${kid}:${newId()}${newId()}` };
    },
    passes: (f) => ({ passes: passes.filter((p) => (!f.kind || (f.kind === "machine") === p.addr.startsWith("@")) && (!f.kids || f.kids.includes(p.kid))) }),
    "people.list": () => ({ people: people.map((p) => ({ ...p, online: p.person === ME || devicesOf(p.person).some((d) => d.online && !d.addr.startsWith("@")), devices: devicesOf(p.person) })), projects }),
    "people.remove": (f) => {
      people.splice(people.findIndex((p) => p.person === f.person), 1);
      for (let i = passes.length - 1; i >= 0; i--) if (passes[i]!.person === f.person && !passes[i]!.addr.startsWith("@")) passes.splice(i, 1);
      return {};
    },
    consent: (f) => {
      let host = "";
      try {
        host = new URL(f.client).host;
        if (new URL(f.back).protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(new URL(f.back).hostname)) throw new Error("back");
      } catch {
        throw new Refusal("bad_client", "адреса возврата нет в описании клиента");
      }
      const kid = "k" + newId().slice(0, 6), addr = `${f.label ?? "claude"}${ME}`;
      passes.unshift({ kid, addr, person: ME, wait: true, at: now(), by: MY_ADDR, online: false });
      return { code: `home:${kid}:${newId()}${newId()}`, kid, addr, client: { name: host, uri: f.client } };
    },
    "fleet.list": (f) => ({
      machines: Object.values(machines).filter((m) => !f.machine || m.name === f.machine), sessions: Object.values(sessions).filter((s) => !f.machine || machineOf(s.callsign) === f.machine),
      people: people.filter((p) => devicesOf(p.person).some((d) => d.online && !d.addr.startsWith("@"))).map((p) => ({ person: p.person, ...(p.name ? { name: p.name } : {}), devices: devicesOf(p.person).filter((d) => d.online && !d.addr.startsWith("@")).map((d) => d.addr) })),
    }),

    /* аккаунты и ключи */
    "slot.set": (f) => {
      const list = accounts[c.mach(f)];
      const order = f.order as string[];
      for (const a of list) if (a.kind === "claude") a.slot = order.includes(a.id) ? order.indexOf(a.id) + 1 : undefined;
      list.sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
      return {};
    },
    "slot.swap": (f) => {
      const list = accounts[c.mach(f)].filter((a) => a.kind === "claude");
      const queue = list.filter((a) => a.slot !== undefined && a.ok && a.wait === undefined);
      const cur = list.find((a) => a.current);
      const next = f.account ? list.find((a) => a.id === f.account) : queue[(queue.indexOf(cur!) + 1) % Math.max(1, queue.length)];
      if (!next || !next.ok) throw new Refusal("no_account", f.account ? `${f.account}: вход не годен` : "годных аккаунтов в очереди нет");
      for (const a of list) a.current = a === next;
      return { account: next.id };
    },
    "keys.list": () => ({ keys }),
    "keys.set": (f) => {
      const k = keys.find((x) => x.name === f.name);
      if (!k && !f.value) throw new Refusal("no_key", `ключа ${f.name} нет: нужно значение`);
      const next = { name: f.name, provider: f.provider, base: f.base, model: f.model, models: f.models, window: f.window, settings: f.settings, env: f.env, at: now(), tail: f.value ? "…" + String(f.value).slice(-4) : k!.tail, sessions: k?.sessions ?? 0 };
      if (k) Object.assign(k, next);
      else keys.push(next);
      return {};
    },
    "keys.remove": (f) => {
      const on = Object.values(sessions).filter((s) => s.spec.account === f.name || s.account === f.name).map((s) => s.callsign);
      if (f.probe) return { sessions: f.name === "meta-muse" && !on.length ? ["wing@laptop"] : on };
      keys.splice(keys.findIndex((k) => k.name === f.name), 1);
      return {};
    },

    /* профили */
    "profile.list": (f) => {
      const m = c.mach(f);
      return { pieces, repos: repos[m] ?? repos.laptop!.map((r) => ({ ...r, state: "ok" as const, op: undefined, error: undefined, files: undefined })) };
    },
    "profile.sync": (f) => {
      const m = c.mach(f);
      const list = (repos[m] ?? (repos[m] = repos.laptop!.map((r) => ({ ...r, state: "ok" as const })))).map((r) => (r.state === "conflict" ? r : r.state === "error" ? r : { ...r, state: "ok" as const, at: now() }));
      repos[m] = list;
      return { repos: list };
    },
    "profile.view": (f) => {
      c.mach(f);
      const picked = (f.pieces as string[]).filter((p) => pieces.find((x) => x.id === p)?.ok);
      const of = (p: string) => [
        { kind: "skill", name: p === "web" ? "shots" : p === "ops" ? "deploy" : "design", piece: p, path: `skills/${p === "web" ? "shots" : p === "ops" ? "deploy" : "design"}/SKILL.md`, about: p === "web" ? "Снимки экранов настоящего кода" : p === "ops" ? "Выкладка по шагам" : "Дизайн в персоне архитектора" },
        { kind: "skill", name: p === "web" ? "a11y" : p === "ops" ? "logs" : "deliver", piece: p, path: `skills/${p === "web" ? "a11y" : p === "ops" ? "logs" : "deliver"}/SKILL.md`, about: p === "web" ? "Проверка доступности" : p === "ops" ? "Разбор журналов" : "Довести принятое до конца" },
        ...(p === "base" ? [
          { kind: "instructions", name: "CLAUDE.md", piece: p, path: "CLAUDE.md", about: "Устав: как работаем, проверка, устройство" },
          { kind: "rule", name: "russian", piece: p, path: "rules/russian.md", about: "Общение по-русски, идентификаторы по-английски" },
          { kind: "hook", name: "PreToolUse", piece: p, about: "Bash → node hooks/gate.mjs" },
          { kind: "agent", name: "architect", piece: p, path: "agents/architect.md", about: "Слепой архитектор" },
          { kind: "memory", name: "memory", piece: p, path: "memory/MEMORY.md", about: "файлов 12" },
        ] : []),
        ...(p === "web" ? [{ kind: "mcp", name: "playwright", piece: p, about: "npx @playwright/mcp" }, { kind: "agent", name: "critic", piece: p, path: "agents/critic.md", about: "Критик прототипа" }, { kind: "command", name: "shots", piece: p, path: "commands/shots.md", about: "Снять экраны" }] : []),
        ...(p === "ops" ? [{ kind: "command", name: "deploy", piece: p, path: "commands/deploy.md", about: "Выложить сборку" }] : []),
      ];
      const settings: Record<string, { value: unknown; from: string; lost: Array<{ value: unknown; from: string }> }> = picked.length ? {
        "permissions.defaultMode": { value: "bypassPermissions", from: picked[0]!, lost: [] },
        ...(picked.includes("web") ? { "env.BROWSER": { value: "chrome", from: "web", lost: picked.includes("ops") ? [{ value: "none", from: "ops" }] : [] } } : {}),
        ...(picked.includes("ops") ? { "includeCoAuthoredBy": { value: false, from: "ops", lost: picked.includes("base") ? [{ value: true, from: "base" }] : [] } } : {}),
      } : {};
      return {
        items: [...picked.flatMap(of), ...Object.entries(settings).map(([name, w]) => ({ kind: "setting", name, piece: w.from, about: JSON.stringify(w.value) }))],
        prompt: picked.includes("base") ? { agent: { name: "architect", from: "base", path: "agents/architect.md" }, style: { name: "plain", from: "base", found: !picked.includes("web"), path: "output-styles/plain.md" }, append: "Память этой сессии: ~/.switchboard2/home/host/data/profiles/example--sb-base/memory — читай MEMORY.md в начале работы." } : {},
        tree: picked.map((id) => ({ id, set: id === "web", ...(id === "web" ? { children: [{ id: "web-shots", set: false }, { id: "web-a11y", set: false }] } : {}) })),
        settings,
        files: Object.fromEntries(picked.map((p) => [p, [{ path: "CLAUDE.md", size: 4812 }, { path: "skills/design/SKILL.md", size: 3120 }, { path: "notes/todo.txt", size: 240 }, { path: "settings.json", size: 512 }]])),
        other: picked.map((p) => ({ from: p, path: "notes/todo.txt" })),
      };
    },

    /* точки и архив */
    "points.save": (f) => {
      const { c: cs } = c.sess(f);
      if (f.move && Object.values(sessions).some((s) => s.spec.wing && s.callsign === cs)) throw new Refusal("has_wing", `${cs} ведёт ведомого: сначала снимите пару`);
      const a = archive.find((x) => x.callsign === cs);
      if (a) (a.points++, (a.last = now()));
      if (f.stop || f.move) c.setRow(cs, { state: "stopped", doing: undefined });
      return { point: "p" + (a?.points ?? 1) };
    },
    "points.raise": (f) => {
      const m = c.mach(f);
      const src = c.need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
      const check = folderCheck(f.cwd ?? src.cwd ?? "", m);
      if (f.dryRun) return { check };
      if (check.folder === "other") throw new Refusal("bad_dir", `${check.dir}: другой репозиторий`);
      const here = sessions[src.callsign] && machineOf(src.callsign) === m && !f.name ? sessions[src.callsign] : undefined;
      if (here && !f.move) {
        // откат на месте: та же сессия запускается с точки
        if (here.state !== "stopped" && here.state !== "failed") throw new Refusal("running", `${here.callsign} ещё идёт: остановите её перед откатом`);
        c.setRow(here.callsign, { state: "idle", last: now(), error: undefined, result: `Откат к точке ${f.point ?? "последней"}` });
        return { callsign: here.callsign };
      }
      const name = f.name ?? src.callsign.split("@")[0];
      const cs = `${name}@${m}`;
      if (sessions[cs]) throw new Refusal("name_taken", `сессия ${cs} уже есть`);
      c.talks.set(cs, [...c.talk(src.callsign)]);
      sessions[cs] = c.row(cs, "idle", src.project, { title: src.title, cwd: f.cwd ?? src.cwd, last: now(), since: now(), ...(f.account ? { account: f.account } : {}) });
      c.delta({ sessions: [{ callsign: cs, row: sessions[cs] }] });
      // перенос: прежняя машина отпускает сессию
      if (f.move && sessions[src.callsign] && src.callsign !== cs) c.setRow(src.callsign, null);
      if (f.move) Object.assign(src, { machine: m, callsign: cs, live: true });
      return { callsign: cs };
    },
    "points.list": (f) => {
      if (f.sid) {
        const s = c.need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
        const pts = c.archPoints(s);
        return { sessions: [s], points: pts.map((p, i) => ({ ...p, ...(i < pts.length - 1 ? { until: p.at + 30 * DAY } : {}) })), more: false };
      }
      const q = String(f.q ?? "").trim().toLowerCase();
      const found = archive.filter((a) => (!f.machine || a.machine === f.machine) && (!f.since || a.last >= f.since)).flatMap((a) => {
        const row = { ...a, live: !!sessions[a.callsign] && sessions[a.callsign].state !== "stopped" };
        if (!q) return [row];
        const line = c.talk(a.callsign).flatMap((e) => (e.type === "assistant" ? (e.message.content as any[]).filter((b) => b.type === "text").map((b) => String(b.text)) : typeof e.message?.content === "string" ? [e.message.content] : [])).flatMap((t) => t.split("\n")).find((l) => l.toLowerCase().includes(q));
        const hit = line ?? (a.title?.toLowerCase().includes(q) ? a.title : undefined);
        return hit ? [{ ...row, hit: hit.slice(0, 160), hitPoint: `p${Math.max(1, a.points - 1)}` }] : [];
      });
      return { sessions: found.sort((a, b) => (f.order === "tokens" ? (b.tokens ?? 0) - (a.tokens ?? 0) : b.last - a.last)), more: false };
    },
    "points.history": (f) => {
      const s = c.need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
      const all = c.talk(s.callsign).length ? c.talk(s.callsign) : [{ type: "user", uuid: "h1", message: { role: "user", content: "Продолжи с прошлого раза." } }, { type: "assistant", uuid: "h2", message: { id: "mh2", content: [{ type: "text", text: `Работа по «${s.title}» доведена до точки. Тесты зелёные.` }] } }, { type: "result", uuid: "h3", duration_ms: 41_000 }];
      const end = f.before ? Math.max(0, all.findIndex((e) => e.uuid === f.before)) : all.length;
      const start = Math.max(0, end - (f.limit ?? 80));
      return { events: all.slice(start, end), more: start > 0, point: f.point ?? `p${s.points}` };
    },
    "points.calls": (f) => {
      const s = c.need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
      const n = 6 + (s.points % 5);
      return { point: f.point ?? `p${s.points}`, calls: Array.from({ length: n }, (_, i) => ({ call: `c${i}`, at: s.last - (n - i) * 4 * MIN, model: s.model ?? "claude-fable-5-2", input: 1200 + i * 310, output: 400 + i * 95, cacheRead: 38_000 + i * 2100, cacheWrite: i ? 900 : 41_000, cost: Math.round((0.04 + i * 0.011) * 1000) / 1000 })) };
    },
    "points.delete": (f) => {
      const i = archive.findIndex((a) => a.sid === f.sid);
      if (i < 0) throw new Refusal("not_found", "такой сессии в архиве нет");
      if (f.expect && f.expect !== `p${archive[i]!.points}`) throw new Refusal("changed", "в архиве уже есть более новая точка");
      archive.splice(i, 1);
      return {};
    },

    /* инциденты, журналы */
    "incident.list": (f) => ({ incidents: incidents[c.mach(f)] ?? [], port: 4890 }),
    "machine.journal": (f) => {
      const kindOf = (l: { level: string; msg: string }) => (/сбой|вышел|failed/.test(l.msg) ? "stop" : /отказ|устарел/.test(l.msg) ? "refuse" : "note");
      const name = f.session ? String(f.session).split("@")[0] : "";
      const all = c.journal(c.mach(f)).filter((l) => (!f.level || l.level === f.level) && (!f.part || l.part === f.part) && (!f.of || l.trace === f.of) && (!f.kind || kindOf(l) === f.kind) && (!f.since || l.t >= f.since) && (!name || l.msg.includes("сессия " + name)));
      const rest = f.before ? all.filter((l) => l.t < f.before) : all;
      return { lines: rest.slice(0, f.limit ?? 40), more: rest.length > (f.limit ?? 40) };
    },
    "ledger.read": (f) => {
      const all = ledger.filter((e) => (!f.what || e.what.startsWith(f.what)) && (!f.machine || e.machine === f.machine));
      if (f.after) return { events: all.filter((e) => e.at > f.after).reverse(), more: false };
      const rest = f.before ? all.filter((e) => e.at < f.before) : all;
      return { events: rest.slice(0, f.limit ?? 50), more: rest.length > (f.limit ?? 50) };
    },

    /* правила прокси */
    "rules.test": (f) => {
      c.mach(f);
      return applyRules(String(f.text), (f.rules as ProxyRule[] | undefined) ?? (prefs.fleet["proxy.rules"] as ProxyRule[]), f.scope ?? "user", f.model ?? "");
    },

    /* связь с людьми */
    "reach.key": () => ({ key: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" }),
    "reach.subscribe": (f) => {
      if (!/^https:\/\//.test(f.endpoint) || String(f.p256dh).length < 20 || String(f.auth).length < 8) throw new Refusal("bad_input", "подписка браузера не разобрана");
      devices.push({ id: "d" + newId().slice(0, 4), kind: "webpush", person: ME, label: f.label ?? "Этот браузер", at: now(), kid: "k1a2b3" });
      return { id: devices.at(-1)!.id };
    },
    "reach.bot": (f) => {
      if (f.token === null) bot = { bot: "", on: false };
      else if (typeof f.token === "string") bot = { bot: "switchboard_fleet_bot", on: true };
      return bot.on ? bot : { on: false };
    },
    "reach.telegram": () => {
      if (!bot.on) throw new Refusal("no_telegram", "бот Telegram у флота не подключён");
      return { code: "SB-" + newId().slice(0, 6).toUpperCase(), bot: bot.bot };
    },

    /* GitHub */
    "github.setup": (f) => (f.code ? { installed: true } : { installed: false, form: { action: "https://github.com/settings/apps/new?state=mock", manifest: { name: "switchboard-fleet", redirect_url: f.redirect } } }),

    /* наблюдение */
    "obs.health": () => {
      const hour = obs.filter((r) => r.at >= now() - HOUR);
      const failed = hour.filter((r) => !r.ok).length;
      const by = new Map<string, number[]>();
      for (const r of hour) (by.get(r.type) ?? (by.set(r.type, []), by.get(r.type)!)).push(r.ms);
      const all = Object.values(machines);
      return {
        machines: { total: all.length, online: all.filter((m) => m.online).length, offline: all.filter((m) => !m.online).map((m) => ({ name: m.name, since: m.since })) },
        sessions: { total: Object.keys(sessions).length, failed: Object.values(sessions).filter((s) => s.state === "failed").map((s) => s.callsign), waiting: Object.values(sessions).filter((s) => s.state === "waiting").length },
        requests: { n: hour.length, failed, rate: hour.length ? failed / hour.length : 0 },
        slow: [...by].map(([type, ms]) => ({ type, n: ms.length, p95: [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]! })).sort((a, b) => b.p95 - a.p95).slice(0, 5),
        failures: ledger.filter((e) => /^(host|keeper|analytics)\.(failed|restarted)$/.test(e.what)).slice(0, 5),
        reports: reports.slice(0, 10),
      };
    },
    "obs.report": (f) => {
      reports.unshift({ at: now(), part: f.part, level: f.level, msg: f.msg, who: MY_ADDR });
      obs.unshift({ trace: "t" + newId(), at: now(), type: "report", from: MY_ADDR, ok: false, word: f.level, why: f.msg, ms: 0 });
      return {};
    },
  };
}
