// Мок флота — запросы второй итерации экранов: перезапуск Host, ссылка на Keeper, состояние Keeper с pid и планом,
// точки с веткой, вызовы модели с текстом, лимиты с временем замера. Ложатся поверх обработчиков screens.ts.
import { type Frame, Refusal } from "@sb/protocol";
import type { MockCtx } from "./screens.ts";

type H = Record<string, (f: any) => unknown>;
const MIN = 60_000;

export function iter2Handlers(c: MockCtx, base: H): H {
  const { machines, now } = c;
  /** машины, у которых Host сейчас перезапускается: до какого времени */
  const restarting = new Map<string, number>();
  const keeperMachine = (f: Frame) => String(f.to).replace(/^\.keeper@/, "");
  return {
    "host.restart": (f) => {
      const m = keeperMachine(f);
      if (!machines[m]?.online) throw new Refusal("offline", `машина ${m} не на связи`);
      restarting.set(m, now() + 6000);
      c.ledger.unshift({ id: "e" + now().toString(36), at: now(), what: "host.restarted", who: c.MY_ADDR, machine: m, text: `Host на ${m} перезапущен` });
      return {};
    },
    "keeper.state": (f) => {
      const m = keeperMachine(f);
      const row = c.need(machines[m], "такой машины нет");
      if (!row.online) throw new Refusal("offline", `машина ${m} не на связи`);
      const until = restarting.get(m) ?? 0;
      const up = until > now();
      return {
        build: row.build, os: row.os,
        host: { build: row.build, state: up ? "updating" : "running", since: up ? now() : until || row.since, pid: 4000 + (m.length * 137) % 900 },
        plan: row.build, pid: 900 + (m.length * 53) % 700,
      };
    },
    "builds.keeper": (f) => {
      const stable = (base["builds.list"]!({}) as { stable: number | null }).stable;
      if (stable === null) throw new Refusal("not_found", "сборка флоту не назначена");
      const file = f.os === "windows" ? "keeper-windows-amd64.exe" : "keeper-linux-amd64";
      return { build: stable, file, url: `https://files.example.com/builds/${stable}/${file}?sig=mock`, sha256: "9f2c".padEnd(64, "0") };
    },
    // у каждой третьей сессии архива — ветка: точка, поднятая не с последней
    "points.list": (f) => {
      const r = base["points.list"]!(f) as { points?: Array<{ point: string; base?: string }> };
      if (f.sid && r.points && r.points.length > 3) r.points = r.points.map((p, i, all) => (i === all.length - 1 ? { ...p, base: all[1]!.point } : p));
      return r;
    },
    // текст вызова: правила прокси проверяются на нём
    "points.calls": (f) => {
      const r = base["points.calls"]!(f) as { point: string; calls: Array<Record<string, unknown>> };
      return { ...r, calls: r.calls.map((x, i) => ({ ...x, text: i % 2 ? "Проверь счёт для ООО «Ромашка»: он лежит на internal.example.com/billing" : undefined, system: i % 2 ? undefined : "Ты работаешь в репозитории internal.example.com/site.\nОтвечай по-русски." })) };
    },
    // текст одного вызова: системный промпт и сообщения до ответа
    "points.call": (f) => ({
      point: f.point ?? "p-last", call: f.call, model: "claude-fable-5-2", more: false,
      system: "Ты работаешь в репозитории сайта. Внутренние адреса вида internal.example.com наружу не называй.",
      messages: [
        { n: 0, role: "user", text: "Проверь счёт для ООО «Ромашка»: он лежит на internal.example.com/billing" },
        { n: 1, role: "assistant", text: "Открываю счёт на internal.example.com/billing." },
        { n: 2, role: "tool", text: "Счёт 412 от 4 ноября, сумма 18 400 ₽" },
      ],
    }),
    // лимиты с временем замера: старше часа подписаны «от ЧЧ:ММ»; вход с датой окончания
    "account.list": (f) => {
      const r = base["account.list"]!(f) as { accounts: Array<{ limits?: Array<Record<string, unknown>>; kind: string; expires?: number }> };
      return { ...r, accounts: r.accounts.map((a, i) => ({ ...a, ...(a.kind === "claude" ? { expires: now() + (20 + i) * 24 * 60 * MIN } : { models: { fast: "orca/flash", smart: "orca/glm" } }), limits: a.limits?.map((l, j) => ({ ...l, at: now() - (j ? 95 : 4) * MIN })) })) };
    },
  };
}
