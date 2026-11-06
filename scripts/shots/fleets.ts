// Флоты стенда снимков: малый — для экранов, большой — там, где важна длина. Образцы данных: снимки сравниваются с ними.
export type S = { cs: string; dir: string; state: string; prof: string | null; model: string; effort: string; who: string; parent?: string; wing?: boolean; slot?: string; q?: string; fail?: string; unread?: string; inc?: string };
export type Prof = { about: string; model: string; effort: string; on: Record<string, string>; files?: string[] };
export type Fleet = { ms: string[]; prof: Record<string, Prof>; ss: S[] };

export const SMALL: Fleet = {
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
    { cs: "audit@win", dir: "~/Projects/switchboard", state: "busy", prof: "ops", model: "opus", effort: "high", who: "me" },
    { cs: "audit-wing@win", dir: "~/Projects/switchboard", state: "busy", prof: "front", model: "haiku", effort: "low", who: "me", parent: "audit@win", wing: true, slot: "kimi" },
  ],
};

export function bigFleet(): Fleet {
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
