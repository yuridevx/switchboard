// Правила замены текста запроса к модели: где искать, для каких моделей, что искать (литерал или регулярка RE2), что править
// (совпадение, строка, абзац, весь блок) и как (заменить, удалить). Правила идут по порядку, каждое — к выходу предыдущего.
// Модель правил — museclaude; регулярки — re2js: линейное время на длинных промптах, без нативной сборки.
import { RE2JS } from "re2js";

/** Где лежит текст запроса: system — промпт и system-сообщения посреди разговора, user, assistant, tool_result — ответ инструмента. */
export type Scope = "system" | "user" | "assistant" | "tool_result";
export const SCOPES: Scope[] = ["system", "user", "assistant", "tool_result"];

/**
 * Правило как хранится в ключе proxy.rules области флота. on — выключено, только если false.
 * models — шаблоны имени модели запроса (* — любые знаки), пусто — все модели; icase — без учёта регистра.
 * replacement — для replace; у регулярки $1, ${имя} подставляют группы, $$ — знак $.
 */
export type Rule = {
  name: string;
  on?: boolean;
  scopes: string[];
  models?: string[];
  kind: "literal" | "regex";
  icase?: boolean;
  unit: "match" | "line" | "paragraph" | "block";
  action: "replace" | "delete";
  pattern: string;
  replacement?: string;
};

/** Сколько раз сработало правило — по имени. */
export type Hits = Record<string, number>;

type Compiled = { rule: Rule; re: RE2JS; models: RegExp[] | null; expand: boolean; rep: string };

const PARAGRAPH = RE2JS.compile("\\n(?:[ \\t]*\\n)+");
const LINE = RE2JS.compile("\\n");

/** Шаблон модели → проверка: * — любые знаки, остальное буквально, без учёта регистра. */
const glob = (m: string) => new RegExp(`^${m.trim().toLowerCase().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

function compileOne(rule: Rule): Compiled {
  if (!rule.pattern) throw new Error("нечего искать");
  if (!rule.scopes?.length) throw new Error("не выбрано, где искать");
  const source = rule.kind === "regex" ? rule.pattern : RE2JS.quote(rule.pattern);
  const re = RE2JS.compile(source, RE2JS.MULTILINE | (rule.icase ? RE2JS.CASE_INSENSITIVE : 0));
  const models = (rule.models ?? []).filter((m) => m.trim());
  return { rule, re, models: models.length ? models.map(glob) : null, expand: rule.kind === "regex", rep: rule.action === "replace" ? (rule.replacement ?? "") : "" };
}

/** Ошибка правила словами или пустая строка. */
export function flawOf(rule: Rule): string {
  try {
    compileOne(rule);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Куски «единица, разделитель, единица, …» по разделителю re. */
function split(text: string, re: RE2JS): string[] {
  const m = re.matcher(text);
  const out: string[] = [];
  let last = 0;
  while (m.find()) {
    out.push(text.slice(last, m.start()), text.slice(m.start(), m.end()));
    last = m.end();
  }
  out.push(text.slice(last));
  return out;
}

/** Подстановка групп совпадения: $1, ${имя}, $$. */
function expand(rep: string, m: ReturnType<RE2JS["matcher"]>): string {
  return rep.replace(/\$(\$|\{(\w+)\}|(\d+))/g, (all, _x, name: string | undefined, num: string | undefined) => {
    if (all === "$$") return "$";
    try {
      const g = name ?? num!;
      return m.group(/^\d+$/.test(g) ? Number(g) : g) ?? "";
    } catch {
      return "";
    }
  });
}

/** Все совпадения в тексте заменены; число совпадений. Пустое совпадение двигает поиск на знак вперёд. */
function replaceMatches(c: Compiled, text: string): [string, number] {
  const m = c.re.matcher(text);
  let out = "";
  let last = 0;
  let n = 0;
  let from = 0;
  while (from <= text.length && m.find(from)) {
    n++;
    out += text.slice(last, m.start()) + (c.expand ? expand(c.rep, m) : c.rep);
    last = m.end();
    from = m.end() > m.start() ? m.end() : m.end() + 1;
  }
  return n ? [out + text.slice(last), n] : [text, 0];
}

/** Замена единицы: у регулярки группы — из первого совпадения в ней. */
function unitReplacement(c: Compiled, unit: string): string {
  if (!c.expand) return c.rep;
  const m = c.re.matcher(unit);
  return m.find() ? expand(c.rep, m) : "";
}

/** Единицы с разделителями: удалённая забирает разделитель после себя, последняя — перед собой. */
function editUnits(c: Compiled, pieces: string[]): [string, number] {
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < pieces.length; i += 2) {
    const unit = pieces[i];
    const sep = pieces[i + 1];
    if (unit && c.re.matcher(unit).find()) {
      n++;
      if (c.rule.action === "replace") out.push(unitReplacement(c, unit), ...(sep === undefined ? [] : [sep]));
      else if (sep === undefined && out.length >= 2) out.pop();
    } else out.push(unit, ...(sep === undefined ? [] : [sep]));
  }
  return [out.join(""), n];
}

function edit(c: Compiled, text: string): [string, number] {
  switch (c.rule.unit) {
    case "match":
      return replaceMatches(c, text);
    case "block":
      return c.re.matcher(text).find() ? [unitReplacement(c, text), 1] : [text, 0];
    case "line":
      return editUnits(c, split(text, LINE));
    case "paragraph":
      return editUnits(c, split(text, PARAGRAPH));
  }
}

/** Набор правил, готовый к работе. Выключенные и неверные правила не применяются; неверные — в flaws по имени. */
export function compile(rules: Rule[]) {
  const ready: Compiled[] = [];
  const flaws: Record<string, string> = {};
  for (const rule of rules) {
    try {
      const c = compileOne(rule);
      if (rule.on !== false) ready.push(c);
    } catch (e) {
      flaws[rule.name] = e instanceof Error ? e.message : String(e);
    }
  }
  /** Один текст: правила его места и модели по порядку; hits копит срабатывания. */
  function apply(scope: Scope, model: string, text: string, hits: Hits): string {
    const id = model.toLowerCase();
    let out = text;
    for (const c of ready) {
      if (!c.rule.scopes.includes(scope) || (c.models && !c.models.some((g) => g.test(id)))) continue;
      const [next, n] = edit(c, out);
      if (n) {
        hits[c.rule.name] = (hits[c.rule.name] ?? 0) + n;
        out = next;
      }
    }
    return out;
  }
  return { apply, flaws, empty: ready.length === 0 };
}

/** Проверка на одном тексте — для редактора: текст после правил и срабатывания. */
export function applyRules(rules: Rule[], scope: Scope, text: string, model = ""): { after: string; hits: Hits } {
  const hits: Hits = {};
  return { after: compile(rules).apply(scope, model, text, hits), hits };
}

type Block = { type?: string; text?: string; content?: unknown };
type Message = { role?: string; content?: unknown };
/** Тело запроса Messages API: правке подлежат только тексты. */
export type MessagesBody = { model?: string; system?: unknown; messages?: Message[] };

/**
 * Правила над запросом Messages API на месте: system (строка или блоки) и system-сообщения — system; тексты сообщений — роль;
 * текст ответа инструмента — tool_result. Остальное не трогается. Ответ — срабатывания; пусто — тело не менялось.
 */
export function editRequest(body: MessagesBody, rules: ReturnType<typeof compile>): Hits {
  const hits: Hits = {};
  if (rules.empty) return hits;
  const model = typeof body.model === "string" ? body.model : "";
  const one = (scope: Scope, text: string) => rules.apply(scope, model, text, hits);
  const blocks = (scope: Scope, list: Block[]) => {
    for (const b of list) if (b?.type === "text" && typeof b.text === "string") b.text = one(scope, b.text);
  };
  if (typeof body.system === "string") body.system = one("system", body.system);
  else if (Array.isArray(body.system)) blocks("system", body.system as Block[]);
  for (const m of body.messages ?? []) {
    const scope: Scope = m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      m.content = one(scope, m.content);
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b?.type === "text" && typeof b.text === "string") b.text = one(scope, b.text);
      else if (b?.type === "tool_result") {
        if (typeof b.content === "string") b.content = one("tool_result", b.content);
        else if (Array.isArray(b.content)) blocks("tool_result", b.content as Block[]);
      }
    }
  }
  return hits;
}
