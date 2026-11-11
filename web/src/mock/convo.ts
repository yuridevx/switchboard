// Разговоры мока: настоящие формы сообщений SDK — текст, вызовы инструментов, субагент, список дел, итог хода.
import type { SdkEvent } from "@sb/protocol";

let n = 0;
export const uid = (p = "u") => `${p}${(++n).toString(36)}`;
const iso = (t: number) => new Date(t).toISOString();
const MODEL = "claude-fable-5-2";

export type Ev = SdkEvent & Record<string, any>;

export const say = (text: string, at: number, extra: object = {}): Ev => ({ type: "user", uuid: uid(), timestamp: iso(at), message: { role: "user", content: text }, ...extra });
export const reply = (blocks: object[], at: number, parent?: string, model = MODEL): Ev => {
  const id = uid("m");
  return { type: "assistant", uuid: id, timestamp: iso(at), ...(parent ? { parent_tool_use_id: parent } : {}), message: { id: "msg_" + id, model, role: "assistant", content: blocks } };
};
export const text = (t: string) => ({ type: "text", text: t });
export const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
export const got = (id: string, content: string, at: number, parent?: string, error = false): Ev => ({
  type: "user", uuid: uid(), timestamp: iso(at), ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }] },
});
export const done = (at: number, ms: number, cost: number, turns: number, ctx: number): Ev => ({
  type: "result", subtype: "success", uuid: uid(), timestamp: iso(at), duration_ms: ms, total_cost_usd: cost, num_turns: turns,
  usage: { input_tokens: 1200, cache_read_input_tokens: ctx, cache_creation_input_tokens: 3000, output_tokens: 2100 },
});

/** Ход «правка сайта»: чтение, список дел, правка, тесты, итог с таблицей. */
export function siteTurn(t: number, ask: string): Ev[] {
  const a = uid("t"), b = uid("t"), c = uid("t"), d = uid("t"), e = uid("t");
  return [
    say(ask, t),
    reply([text("Посмотрю, как сейчас собрана шапка, и где она ломается на узких экранах."), use(a, "Read", { file_path: "src/components/Header.tsx" })], t + 4_000),
    got(a, "export function Header() {\n  return (\n    <header className=\"header\">\n      <Logo />\n      <Nav items={items} />\n      <UserMenu />\n    </header>\n  );\n}", t + 5_000),
    reply([use(b, "TodoWrite", { todos: [
      { content: "Перевести шапку на сетку", status: "completed", activeForm: "Перевожу шапку на сетку" },
      { content: "Свернуть меню в кнопку на узком экране", status: "in_progress", activeForm: "Сворачиваю меню" },
      { content: "Прогнать тесты и снимки", status: "pending", activeForm: "Гоняю тесты" },
    ] })], t + 9_000),
    got(b, "Todos have been modified successfully", t + 9_500),
    reply([use(c, "Edit", { file_path: "src/components/Header.tsx", old_string: "<Nav items={items} />", new_string: "{narrow ? <MenuButton items={items} /> : <Nav items={items} />}" })], t + 21_000),
    got(c, "The file src/components/Header.tsx has been updated.", t + 21_600),
    reply([use(d, "Bash", { command: "npm test -- header", description: "Тесты шапки" })], t + 30_000),
    got(d, " ✓ src/components/Header.test.tsx (6 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)", t + 41_000),
    reply([use(e, "TodoWrite", { todos: [
      { content: "Перевести шапку на сетку", status: "completed" },
      { content: "Свернуть меню в кнопку на узком экране", status: "completed" },
      { content: "Прогнать тесты и снимки", status: "completed" },
    ] })], t + 43_000),
    got(e, "Todos have been modified successfully", t + 43_400),
    reply([text("Шапка больше не ломается на узких экранах: меню сворачивается в кнопку ниже 720 px.\n\n| Проверка | До | После |\n|---|---|---|\n| Тесты шапки | 5 из 6 | 6 из 6 |\n| Ширина без прокрутки | от 860 px | от 320 px |\n\nИзменён один файл:\n\n```tsx\n{narrow ? <MenuButton items={items} /> : <Nav items={items} />}\n```\n\nСнимки на 390 и 1440 лежат в `shots/header/`.")], t + 52_000),
    done(t + 53_000, 53_000, 0.42, 7, 64_000),
  ];
}

/** Ход с субагентом: исследование перед правкой. */
export function researchTurn(t: number, ask: string): Ev[] {
  const task = uid("t"), g = uid("t"), r = uid("t"), w = uid("t");
  return [
    say(ask, t),
    reply([text("Сначала выясню, где ещё используется старый клиент оплаты."), use(task, "Task", { description: "Найти все вызовы старого клиента оплаты", subagent_type: "Explore", prompt: "Найди все импорты payments/legacy и места вызова charge()" })], t + 3_000),
    reply([use(g, "Grep", { pattern: "payments/legacy", glob: "**/*.ts" })], t + 6_000, task),
    got(g, "src/checkout/pay.ts:3\nsrc/admin/refund.ts:8\nsrc/jobs/renew.ts:2", t + 7_000, task),
    reply([use(r, "Read", { file_path: "src/jobs/renew.ts" })], t + 9_000, task),
    got(r, "import { charge } from \"../payments/legacy\";\n\nexport async function renew(sub: Subscription) {\n  return charge(sub.customer, sub.price);\n}", t + 10_000, task),
    got(task, "Старый клиент зовут три файла: checkout/pay.ts, admin/refund.ts, jobs/renew.ts. Во всех — только charge().", t + 14_000),
    reply([use(w, "Bash", { command: "git grep -n \"charge(\" -- src | wc -l" })], t + 17_000),
    got(w, "3", t + 18_000),
    reply([text("Старый клиент оплаты зовут три файла, все через `charge()`. Заменить можно одной обёрткой без правки вызовов:\n\n1. `checkout/pay.ts` — оплата заказа\n2. `admin/refund.ts` — возврат\n3. `jobs/renew.ts` — продление подписки\n\nДелаю обёртку?")], t + 24_000),
    done(t + 25_000, 25_000, 0.18, 4, 38_000),
  ];
}

/** Короткий ход: вопрос и ответ. */
export function shortTurn(t: number, ask: string, answer: string): Ev[] {
  return [say(ask, t), reply([text(answer)], t + 6_000), done(t + 7_000, 7_000, 0.03, 1, 21_000)];
}

/** Ход, который идёт сейчас: шаги выдаются по одному таймером мока. */
export function liveSteps(now: () => number, about: string): Array<() => Ev[]> {
  const a = uid("t"), b = uid("t"), c = uid("t");
  return [
    () => [reply([text(`Берусь: ${about}. Сначала посмотрю, что уже есть.`), use(a, "Glob", { pattern: "src/**/*.ts" })], now())],
    () => [got(a, "src/index.ts\nsrc/routes.ts\nsrc/lib/http.ts\nsrc/lib/retry.ts", now())],
    () => [reply([use(b, "Read", { file_path: "src/lib/http.ts" })], now())],
    () => [got(b, "export async function http(url: string, init?: RequestInit) {\n  const res = await fetch(url, init);\n  if (!res.ok) throw new Error(`HTTP ${res.status}`);\n  return res.json();\n}", now())],
    () => [reply([text("Нашёл место. Добавляю предел ожидания и слово отказа вместо голого исключения."), use(c, "Edit", { file_path: "src/lib/http.ts", old_string: "const res = await fetch(url, init);", new_string: "const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });" })], now())],
    () => [got(c, "The file src/lib/http.ts has been updated.", now())],
    () => [reply([text("Готово: у запроса теперь предел 10 секунд, отказ приходит словом `timeout`. Тесты `http` — 9 из 9.")], now()), done(now(), 48_000, 0.21, 4, 52_000)],
  ];
}

export const peer = (from: string, body: string, at: number): Ev => say(`<fleet-message from="${from}">\n${body}\n</fleet-message>`, at);
