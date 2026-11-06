// Кандидаты для старшего: только читает. Запускается через census.ts snapshot.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { eachFunction } from "./functions.mjs";

const [root, out] = process.argv.slice(2);
const ts = createRequire(join(process.cwd(), "package.json"))("typescript");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 29 });
const TEST = /(\/test\/|\/tests\/|\.test\.|\.spec\.|\.d\.ts$)/;
// дома и исключения — от привязки проекта, через census.ts
const houses = JSON.parse(process.env.SLOPIK_HOUSES ?? "[]").sort((a, b) => b.dir.length - a.dir.length);
const IGNORE = process.env.SLOPIK_IGNORE ? new RegExp(process.env.SLOPIK_IGNORE) : null;
const moduleOf = (f) => houses.find((h) => f.startsWith(h.dir))?.name ?? f.split("/")[0];
const files = git("ls-files").split("\n").filter((f) => /\.(ts|tsx|mjs|js|jsx)$/.test(f) && !TEST.test(f) && !IGNORE?.test(f));

const fns = [];
const wrappers = [];
/** Булев параметр решает ветку три раза и больше: слияние через флаг. */
const flags = [];
const LITERAL = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.JsxText, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
const literals = (sf, n, acc = new Set()) => {
  if (ts.isJSDoc(n)) return acc;
  if (ts.isToken(n)) {
    if (LITERAL.has(n.kind)) {
      const v = n.getText(sf).replace(/^["'}`]|["'`]$|\$\{$/g, "").trim();
      if (v.length >= 4 && !v.includes("\n")) acc.add(v);
    }
  } else n.getChildren(sf).forEach((k) => literals(sf, k, acc));
  return acc;
};
const boolParams = (n) => n.parameters.flatMap((p) => {
  if (ts.isIdentifier(p.name) && p.type?.kind === ts.SyntaxKind.BooleanKeyword) return [p.name.text];
  if (ts.isObjectBindingPattern(p.name) && p.type && ts.isTypeLiteralNode(p.type)) return p.type.members.filter((m) => ts.isPropertySignature(m) && m.type?.kind === ts.SyntaxKind.BooleanKeyword).map((m) => m.name.getText());
  return [];
});
const branchesOn = (body, name) => {
  const word = new RegExp("\\b" + name + "\\b");
  let c = 0;
  const walk = (x) => {
    if ((ts.isConditionalExpression(x) || ts.isIfStatement(x)) && word.test((x.condition ?? x.expression).getText())) c++;
    ts.forEachChild(x, walk);
  };
  walk(body);
  return c;
};
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  const leaves = (sf, n, acc = []) => {
    if (ts.isJSDoc(n)) return acc;
    if (ts.isToken(n)) {
      if (n.kind === ts.SyntaxKind.EndOfFileToken) return acc;
      if (n.kind === ts.SyntaxKind.Identifier) acc.push("I");
      else if (n.kind === ts.SyntaxKind.StringLiteral || n.kind === ts.SyntaxKind.NumericLiteral || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) acc.push("L");
      else acc.push(String(n.kind));
    } else n.getChildren(sf).forEach((k) => leaves(sf, k, acc));
    return acc;
  };
  eachFunction(ts, file, text, (n, sf, owner, line) => {
    const toks = leaves(sf, n.body);
    fns.push({ name: owner, file, line, mod: moduleOf(file), toks, lits: literals(sf, n.body), pos: n.getStart(sf), end: n.end });
    for (const b of boolParams(n)) if (branchesOn(n.body, b) >= 3) flags.push(`${file}:${owner ?? line}:${b}`);
    // сквозная обёртка: тело — один вызов, аргументы только параметры
    const body = ts.isBlock(n.body) ? (n.body.statements.length === 1 ? n.body.statements[0] : null) : n.body;
    const expr = body && (ts.isReturnStatement(body) ? body.expression : ts.isExpressionStatement(body) ? body.expression : ts.isExpression(body) ? body : null);
    const call = expr && ts.isAwaitExpression(expr) ? expr.expression : expr;
    if (owner && call && ts.isCallExpression(call)) {
      const params = n.parameters.map((p) => p.name.getText(sf));
      const args = call.arguments.map((a) => a.getText(sf));
      if (args.length === params.length && args.every((a, i) => a === params[i])) wrappers.push({ name: owner, to: call.expression.getText(sf).slice(0, 50), file, line });
    }
  });
}

// 1. одно имя в разных модулях, тело не пустяк
const byName = new Map();
for (const f of fns) if (f.name && !/^["'[]/.test(f.name) && f.toks.length >= 12) (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)).push(f);
const COMMON = new Set(["start", "stop", "render", "constructor", "fetch", "get", "set", "run", "close", "open", "default", "view", "make", "main", "send", "request", "read", "write", "on", "log", "add", "remove", "load", "save", "list", "update", "create", "init", "handle", "handler", "onClick", "onChange", "Screen", "module", "state"]);
const sameName = [...byName].map(([name, l]) => ({ name, mods: [...new Set(l.map((x) => x.mod))], l })).filter((x) => x.mods.length > 1 && !COMMON.has(x.name)).sort((a, b) => b.mods.length - a.mods.length || b.l[0].toks.length - a.l[0].toks.length);

// 2. почти-клоны функций: шинглы нормализованных токенов. Редкие шинглы — только индекс кандидатов, Жаккар — точный по всем шинглам.
const K = 5;
const big = fns.filter((f) => f.toks.length >= 30);
for (const f of big) {
  f.sh = new Set();
  for (let i = 0; i + K <= f.toks.length; i++) f.sh.add(f.toks.slice(i, i + K).join(" "));
}
const index = new Map();
big.forEach((f, i) => { for (const s of f.sh) (index.get(s) ?? index.set(s, []).get(s)).push(i); });
const cand = new Set();
for (const list of index.values()) {
  if (list.length > 60) continue;
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) cand.add(list[a] * 100000 + list[b]);
}
// редкий литерал — след самой копии: распространённые строки её не выдают
const litFiles = new Map();
for (const f of fns) for (const l of f.lits) (litFiles.get(l) ?? litFiles.set(l, new Set()).get(l)).add(f.file);
const RARE = 6;
const label = (f) => f.name ?? `${f.file}#${createHash("sha1").update(f.toks.join(" ")).digest("hex").slice(0, 8)}`;
const near = [], nearIn = [];
for (const key of cand) {
  const x = big[Math.floor(key / 100000)], y = big[key % 100000];
  if (x.file === y.file && ((x.pos <= y.pos && y.end <= x.end) || (y.pos <= x.pos && x.end <= y.end))) continue; // вложенная функция — не клон своей обёртки
  let c = 0;
  for (const s of x.sh) if (y.sh.has(s)) c++;
  const j = c / (x.sh.size + y.sh.size - c);
  if (j < 0.5) continue;
  const row = { ka: `${x.mod}:${label(x)}`, kb: `${y.mod}:${label(y)}`, lits: [...x.lits].filter((l) => y.lits.has(l) && litFiles.get(l).size <= RARE), fa: `${x.file}:${x.line}`, fb: `${y.file}:${y.line}`, j: +j.toFixed(2), a: `${x.mod} ${x.name ?? "?"} ${x.file}:${x.line}`, b: `${y.mod} ${y.name ?? "?"} ${y.file}:${y.line}`, toks: Math.min(x.toks.length, y.toks.length) };
  (x.mod === y.mod ? nearIn : near).push(row);
}
near.sort((p, q) => q.toks * q.j - p.toks * p.j);
nearIn.sort((p, q) => q.toks * q.j - p.toks * p.j);

// 3. совместные правки между модулями: коммиты до 12 файлов кода, без слияний
const log = git("log", "--no-merges", "--name-only", "--format=@%h", "--max-count=2000");
const pairs = new Map();
const revs = new Map();
for (const block of log.split("@").slice(1)) {
  const list = block.split("\n").slice(1).filter((f) => /\.(ts|tsx|mjs|js|jsx|go)$/.test(f) && !TEST.test(f) && !IGNORE?.test(f));
  if (list.length === 0 || list.length > 12) continue;
  const mods = [...new Set(list.map(moduleOf))].sort();
  for (const m of mods) revs.set(m, (revs.get(m) ?? 0) + 1);
  for (let a = 0; a < mods.length; a++) for (let b = a + 1; b < mods.length; b++) { const k = `${mods[a]} + ${mods[b]}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
}
const coupled = [...pairs].map(([k, n]) => { const [a, b] = k.split(" + "); return { k, n, deg: +(n / Math.min(revs.get(a), revs.get(b))).toFixed(2) }; }).filter((x) => x.n >= 5).sort((p, q) => q.n * q.deg - p.n * p.deg);

const lines = [];
lines.push(`файлов ${files.length} · функций ${fns.length}`);
lines.push(`\n== одно имя в разных модулях: ${sameName.length} имён, ${sameName.reduce((n, x) => n + x.l.length, 0)} функций`);
for (const x of sameName.slice(0, 45)) lines.push(`${x.name} ×${x.l.length} [${x.mods.join(", ")}] ${x.l[0].toks.length} ток · ${x.l.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(" ")}`);
lines.push(`\n== почти-клоны функций между модулями (Жаккар ≥ 0,5): ${near.length}`);
for (const n of near.slice(0, 80)) lines.push(`${n.j} · ${n.toks} ток\n  ${n.a}\n  ${n.b}`);
lines.push(`
== почти-клоны внутри модуля: ${nearIn.length}`);
for (const n of nearIn.slice(0, 500)) lines.push(`${n.j} · ${n.toks} ток | ${n.a} | ${n.b}`);
lines.push(`\n== сквозные обёртки: ${wrappers.length}`);
for (const w of wrappers.slice(0, 40)) lines.push(`${w.name} → ${w.to} · ${w.file}:${w.line}`);
lines.push(`\n== совместные правки между модулями: ${coupled.length} пар`);
for (const c of coupled.slice(0, 25)) lines.push(`${c.k}: ${c.n} коммитов, связанность ${c.deg}`);
writeFileSync(out, lines.join("\n"));
writeFileSync(out + ".json", JSON.stringify({ functions: fns.length, small: fns.filter((f) => f.toks.length < 30).length, flags, near: near.map(({ ka, kb, fa, fb, lits, j, toks }) => ({ ka, kb, fa, fb, lits, j, toks })), inside: nearIn.map(({ ka, kb, fa, fb, lits, j, toks }) => ({ ka, kb, fa, fb, lits, j, toks })) }));
console.log(`файлов ${files.length} · функций ${fns.length} · одноимённых ${sameName.length} · почти-клонов ${near.length} (внутри модуля ${nearIn.length}) · обёрток ${wrappers.length} · связанных пар ${coupled.length}`);
