// Вторая итерация: чистая логика — дерево «Работы» и пара, «почему моё», разница правки, итог вопроса и «вопрос видят», «Вам», поле папки.
import type { Ask, MachineRow, SessionRow } from "@sb/protocol";
import { describe, expect, it } from "vitest";
import { fold } from "../chat/fold.ts";
import { rowMark } from "../common.tsx";
import { groupsByMachine, matches, treeOf, whyMine } from "../lib/work.ts";
import { tabInto } from "../shell/NewSession.tsx";
import type { Picture } from "../store/fleet.ts";
import { askOutcome, seenWord } from "./answers.ts";
import { returned } from "./Composer.tsx";
import { pairOf, toggleHeadPart } from "./Conversation.tsx";
import { diffLines } from "./diff.ts";
import { modelsFor } from "./doc.ts";
import { looksSvg, previewKind, svgUrl } from "./html.tsx";
import { pairRows } from "./Inspector.tsx";

const ME = "~yuri@example.com";
const row = (callsign: string, r: Partial<SessionRow> & { parent?: string; wing?: string; pieces?: string[] } = {}): SessionRow => {
  const { parent, wing, pieces, ...rest } = r;
  return { callsign, state: "idle", by: "pult" + ME, since: 1, last: 1, spec: { name: callsign.split("@")[0]!, cwd: "~/p", ...(parent ? { parent } : {}), ...(wing ? { wing } : {}), ...(pieces ? { pieces } : {}) }, ...rest };
};
const machine = (name: string, online = true): MachineRow => ({ name, online, owner: ME, since: 1 });
const picture = (rows: SessionRow[], machines: MachineRow[] = [machine("laptop"), machine("server")]): Picture => ({
  rev: 1, you: { addr: "pult" + ME, person: ME, admin: true },
  machines: Object.fromEntries(machines.map((m) => [m.name, m])), sessions: Object.fromEntries(rows.map((s) => [s.callsign, s])),
});

describe("«Работа»: дерево и пара", () => {
  const rows = [
    row("lead@laptop", { wing: "wing@laptop" }),
    row("wing@laptop", { by: "lead@laptop", lead: "lead@laptop", parent: "lead@laptop" }),
    row("child@laptop", { by: "lead@laptop", parent: "lead@laptop" }),
    row("grand@laptop", { by: "child@laptop" }),
    row("solo@server"),
  ];
  it("пара — одной строкой: ведомый своей строкой не стоит, он в строке ведущего; дочерние — под родителем с отступом", () => {
    const tree = treeOf(picture(rows), rows);
    expect(tree.map((r) => [r.s.callsign, r.depth, r.wing?.callsign])).toEqual([["lead@laptop", 0, "wing@laptop"], ["child@laptop", 1, undefined], ["grand@laptop", 2, undefined], ["solo@server", 0, undefined]]);
  });
  it("без «дочерние под родителем» отступов нет, пара всё равно одной строкой; ведомый без ведущего в списке стоит сам", () => {
    expect(treeOf(picture(rows), rows, false).map((r) => [r.s.callsign, r.depth])).toEqual([["lead@laptop", 0], ["child@laptop", 0], ["grand@laptop", 0], ["solo@server", 0]]);
    const only = rows.filter((s) => s.callsign !== "lead@laptop");
    expect(treeOf(picture(rows), only).map((r) => r.s.callsign)).toContain("wing@laptop");
  });
  it("круг «кто кого открыл» не теряет строк", () => {
    const loop = [row("a@laptop", { by: "b@laptop" }), row("b@laptop", { by: "a@laptop" })];
    expect(treeOf(picture(loop), loop).map((r) => r.s.callsign).sort()).toEqual(["a@laptop", "b@laptop"]);
  });
  it("«почему моё»: открыл я, открыла моя сессия, закрепил; чужая без закрепления — пусто", () => {
    const p = picture([...rows, row("alien@server", { by: "pult~anya@example.com" })]);
    expect(whyMine(p, p.sessions["solo@server"]!, [])).toBe("вы открыли");
    expect(whyMine(p, p.sessions["child@laptop"]!, [])).toBe("открыла ваша сессия lead@laptop");
    expect(whyMine(p, p.sessions["alien@server"]!, ["alien@server"])).toBe("вы закрепили");
    expect(whyMine(p, p.sessions["alien@server"]!, [])).toBe("");
  });
  it("группы по машинам; фильтр по кусочкам берёт сессию с любым из названных", () => {
    expect(groupsByMachine(rows, (m) => (m === "laptop" ? "Ноутбук" : m)).map((g) => [g.project, g.name, g.rows.length])).toEqual([["@server", "server", 1], ["@laptop", "Ноутбук", 4]].sort((a, b) => String(a[1]).localeCompare(String(b[1]), "ru")));
    const p = picture([row("web@laptop", { pieces: ["base", "web"] }), row("ops@laptop", { pieces: ["ops"] })]);
    const f = { id: "f", name: "веб", who: "all" as const, pieces: ["web", "design"] };
    expect(Object.values(p.sessions).filter((s) => matches(p, s, f, [])).map((s) => s.callsign)).toEqual(["web@laptop"]);
  });
  it("знак строки: «?» у ждущей ответа, точка у непрочитанной, у прочитанной — ничего", () => {
    expect(rowMark(row("a@laptop", { ask: { id: "q", kind: "question", text: "?", at: 1 }, unread: [ME] }), ME)).toBe("ask");
    expect(rowMark(row("a@laptop", { unread: [ME] }), ME)).toBe("new");
    expect(rowMark(row("a@laptop", { unread: ["~anya@example.com"] }), ME)).toBeNull();
  });
});

describe("пара в разговоре", () => {
  const sessions = picture([row("lead@laptop", { wing: "wing@laptop" }), row("wing@laptop", { lead: "lead@laptop" }), row("solo@server")]).sessions;
  it("пара находится с любой стороны; у одиночной сессии пары нет", () => {
    expect(pairOf(sessions, "lead@laptop")).toEqual({ lead: "lead@laptop", wing: "wing@laptop" });
    expect(pairOf(sessions, "wing@laptop")).toEqual({ lead: "lead@laptop", wing: "wing@laptop" });
    expect(pairOf(sessions, "solo@server")).toBeNull();
    expect(pairOf(sessions, "нет@laptop")).toBeNull();
  });
  it("«Сведения» пары: общие ряды, две колонки — ведущий и ведомый", () => {
    const rows = pairRows(row("lead@laptop", { state: "busy", doing: "Ждёт итог", account: "work@example.com", pieces: ["base"] } as never), row("wing@laptop", { state: "waiting" }));
    expect(rows.map((r) => r[0])).toEqual(["Состояние", "Модель", "Очередь", "Кусочки", "Папка", "Открыта"]);
    expect(rows[0]).toEqual(["Состояние", "Ждёт итог", "ждёт вас"]);
    expect(rows[2]).toEqual(["Очередь", "— · work@example.com", "—"]);
  });
  it("модели сессии: у ключа флота — одна, записанная у ключа; у входа Claude — список SDK", () => {
    const sdk = [{ value: "default", label: "Default" }, { value: "opus", label: "Opus" }];
    expect(modelsFor({ kind: "key", model: "orca/flash" }, sdk)).toEqual([{ value: "orca/flash", label: "orca/flash" }]);
    expect(modelsFor({ kind: "claude" }, sdk)).toBe(sdk);
    expect(modelsFor(undefined, sdk)).toBe(sdk);
  });
  it("части шапки: переключение держит порядок списка", () => {
    expect(toggleHeadPart(["model", "pieces"], "machine")).toEqual(["model", "pieces", "machine"]);
    expect(toggleHeadPart(["model", "pieces"], "effort")).toEqual(["model", "effort", "pieces"]);
    expect(toggleHeadPart(["model", "pieces"], "model")).toEqual(["pieces"]);
  });
});

describe("лента", () => {
  it("правка: общие куски свёрнуты до числа строк, вокруг изменения остаётся по две строки", () => {
    const before = Array.from({ length: 20 }, (_, i) => `строка ${i}`).join("\n");
    const after = before.replace("строка 10", "новая 10");
    const d = diffLines(before, after);
    expect(d.filter((l) => l.k === "old")).toEqual([{ k: "old", text: "строка 10" }]);
    expect(d.filter((l) => l.k === "new")).toEqual([{ k: "new", text: "новая 10" }]);
    expect(d[0]).toEqual({ k: "fold", n: 8 });
    expect(d.at(-1)).toEqual({ k: "fold", n: 7 });
    expect(d.filter((l) => l.k === "same")).toHaveLength(4);
    // целиком — без свёрток
    expect(diffLines(before, after, Number.MAX_SAFE_INTEGER).some((l) => l.k === "fold")).toBe(false);
  });
  it("правка без общих строк — всё старое и всё новое; короткий общий кусок не сворачивается", () => {
    expect(diffLines("a\nb", "c\nd").map((l) => l.k)).toEqual(["old", "old", "new", "new"]);
    expect(diffLines("a\nx\nb", "a\ny\nb").map((l) => l.k)).toEqual(["same", "old", "new", "same"]);
  });
  it("SVG узнаётся по языку блока и по содержимому; показывается картинкой из данных", () => {
    expect(looksSvg("svg", "что угодно")).toBe(true);
    expect(looksSvg("xml", '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>')).toBe(true);
    expect(looksSvg("", "<div>не svg</div>")).toBe(false);
    expect(previewKind("", "<!doctype html><html></html>")).toBe("html");
    expect(previewKind("", "<svg></svg>")).toBe("svg");
    expect(previewKind("ts", "const a = 1")).toBeNull();
    expect(svgUrl("<svg/>")).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
  });
  it("итог вопроса — строкой ленты: кто ответил и чем; ход снял вопрос — «вопрос снят»; ответ из уведомления помечен", () => {
    const v = fold([
      { type: "ask.answered", uuid: "a1", ask: "q1", kind: "question", by: "phone" + ME, answer: { answers: { "Ветка?": "main" } }, via: "push", at: 1 },
      { type: "ask.answered", uuid: "a2", ask: "q2", kind: "permission", by: "pult~anya@example.com", answer: { action: "deny", message: "не трогай dist" }, at: 2 },
      { type: "ask.answered", uuid: "a3", ask: "q3", kind: "plan", answer: "cancelled", at: 3 },
    ]);
    expect(v.rows.map((r) => (r.k === "line" ? r.text + (r.dim ?? "") : r.k))).toEqual(["отвечено: main · phone yuri · из уведомления", "отвечено: отклонить: не трогай dist · pult anya", "вопрос снят"]);
    expect(askOutcome({ kind: "plan", by: "pult" + ME, answer: { action: "allow_always" } }, ME)).toEqual({ text: "отвечено: одобрить и разрешать правки", dim: " · вы (pult)" });
    expect(askOutcome({ kind: "form", answer: { action: "accept", content: { a: 1 } } }).text).toBe("отвечено: форма заполнена");
  });
  it("«Вопрос видят»: адресат и зрители; свои устройства — «вы» один раз; никого — строки нет", () => {
    const ask = (a: Partial<Ask>): Pick<Ask, "to" | "seen"> => a;
    expect(seenWord(ask({ to: ME, seen: ["pult" + ME, "phone" + ME, "pult~anya@example.com", "lead@laptop"] }), ME)).toBe("Вопрос видят: вы (pult, phone), pult anya, lead@laptop");
    expect(seenWord(ask({ to: "lead@laptop" }), ME)).toBe("Вопрос видят: lead@laptop");
    expect(seenWord(ask({}), ME)).toBe("");
  });
  it("отменённое сообщение возвращает текст в поле: к набранному — с новой строки", () => {
    expect(returned("", "проверь ссылки")).toBe("проверь ссылки");
    expect(returned("уже пишу  \n", "проверь ссылки")).toBe("уже пишу\nпроверь ссылки");
  });
});

describe("новая сессия: поле папки", () => {
  it("Tab дополняет до единственной подпапки и входит в неё; до общего начала нескольких; нечего дополнять — Tab идёт дальше", () => {
    expect(tabInto("~/projects", "si", ["site", "docs"])).toBe("~/projects/site/");
    expect(tabInto("~/projects", "s", ["site", "site-tests", "docs"])).toBe("~/projects/site");
    expect(tabInto("~/projects", "site", ["site", "site-tests"])).toBeNull();
    expect(tabInto("~/projects", "", ["site", "docs"])).toBeNull();
    expect(tabInto("~/projects", "zz", ["site"])).toBeNull();
    expect(tabInto("C:\\work", "ap", ["api"])).toBe("C:\\work\\api\\");
  });
});
