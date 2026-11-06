// Забытые близнецы между двумя снимками. Определения — evals/twins-prereg.md. Читает только git и снимки SLOPIK_HOME, итог дописывает в журнал.
//   twins.ts <до> <после> [--root <repo>]
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home, journalFile, load, type Pair, type Snapshot } from "./census.ts";
import { CODE, eachFunction, loadTs, TEST } from "./functions.mjs";

const ts = loadTs();
const here = dirname(fileURLToPath(import.meta.url));

const MASS = 12; // порог массового коммита — тот же, что у совместных правок в scan.mjs
const TASK_GAP = 3600; // секунд: дольше — другая задача
const REWRITE = 0.3;
const SAME_FORM = 0.5;
const SAME_EDIT = 0.5;

type Fn = { name: string | null; line: number; hash: string; text: string[]; shape: string[]; form?: Set<string> };
type Step = { c: string; parents: string[]; time: number };
type Spot = { path: string; i: number };
type Edit = { side: string; c: string; parent: string; task: string; time: number; before: Fn; after: Fn; rewrite: boolean };
export type Episode = { kind: "late" | "diverged" | "closer"; edited: string; other: string; side: string; commit: string; time: number; late?: string; lagMinutes?: number };
export type Fate = { ka: string; kb: string; fa: string; fb: string; moved: boolean; sync: number; rewrites: number; alone: number; broken: boolean; episodes: Episode[] };

const shingles = (list: string[], k: number) => {
  const out = new Set<string>();
  if (list.length && list.length < k) out.add(list.join(" "));
  for (let i = 0; i + k <= list.length; i++) out.add(list.slice(i, i + k).join(" "));
  return out;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  let common = 0;
  for (const s of a) if (b.has(s)) common++;
  return common / (a.size + b.size - common || 1);
};
const form = (f: Fn) => (f.form ??= shingles(f.shape, 5));

/** Лексемы функции без комментариев, типов, `as`, `!`; локальные имена канонизированы: переименование — не правка. */
function lexemes(fn: any, sf: any): Pick<Fn, "hash" | "text" | "shape"> {
  const locals = new Set<string>();
  const declared = (n: any) => {
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name)) locals.add(n.name.text);
    ts.forEachChild(n, declared);
  };
  declared(fn);
  const member = (n: any) => (ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAssignment(n.parent)) && n.parent.name === n;
  const order = new Map<string, number>();
  const canon: string[] = [];
  const text: string[] = [];
  const shape: string[] = [];
  const put = (c: string, t: string, s: string) => (canon.push(c), text.push(t), shape.push(s));
  const walk = (n: any): void => {
    if (ts.isJSDoc(n) || ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isTypeParameterDeclaration(n)) return;
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n)) return walk(n.expression);
    if (ts.isToken(n)) {
      if (ts.isIdentifier(n)) {
        if (locals.has(n.text) && !member(n)) {
          if (!order.has(n.text)) order.set(n.text, order.size);
          put(`$${order.get(n.text)}`, "I", "I");
        } else put(n.text, n.text, "I");
      } else if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) put(`'${n.text}'`, `'${n.text}'`, "L");
      else if (n.kind === ts.SyntaxKind.JsxText) {
        const t = n.getText(sf).replace(/\s+/g, " ").trim();
        if (t) put(t, t, "L");
      } else put(n.getText(sf), n.getText(sf), String(n.kind));
      return;
    }
    const kids = n.getChildren(sf);
    kids.forEach((k: any, i: number) => {
      if (k.kind === ts.SyntaxKind.ColonToken && kids[i + 1] && ts.isTypeNode(kids[i + 1])) return;
      walk(k);
    });
  };
  fn.parameters.forEach(walk);
  put("=>", "=>", "=>");
  walk(fn.body);
  return { hash: canon.join("\u0001"), text, shape };
}

/** Какая функция файла после правки — какая была до: точный текст, затем имя, затем форма. */
function follow(a: Fn[], b: Fn[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(a.length);
  const used = new Set<number>();
  const take = (ok: (x: Fn, y: Fn) => boolean) =>
    a.forEach((x, i) => {
      if (out[i] !== undefined) return;
      const j = b.findIndex((y, k) => !used.has(k) && ok(x, y));
      if (j >= 0) (out[i] = j), used.add(j);
    });
  take((x, y) => x.hash === y.hash && x.name === y.name);
  take((x, y) => x.hash === y.hash);
  take((x, y) => x.name !== null && x.name === y.name);
  a.forEach((x, i) => {
    if (out[i] !== undefined) return;
    let best = -1, score = SAME_FORM;
    b.forEach((y, k) => {
      if (used.has(k)) return;
      const s = jaccard(form(x), form(y));
      if (s >= score) (best = k), (score = s);
    });
    if (best >= 0) (out[i] = best), used.add(best);
  });
  return out;
}

/** Смена функции: добавленные и убранные лексемы по порядку; у такой же правки на близнеце шинглы совпадают. */
function delta(x: string[], y: string[]): Set<string> {
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const a = x.slice(s, x.length - e), b = y.slice(s, y.length - e);
  if (a.length * b.length > 4e6) return shingles([...a.map((t) => `-${t}`), ...b.map((t) => `+${t}`)], 3);
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) i++, j++;
    else if (j < b.length && (i === a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) out.push(`+${b[j++]}`);
    else out.push(`-${a[i++]}`);
  }
  return shingles(out, 3);
}

/** Задача: отрезок истории без развилок и слияний, разрыв дольше часа режет его. */
export function tasks(steps: Step[], from: string): Map<string, string> {
  const kids = new Map<string, number>();
  for (const s of steps) for (const p of s.parents) kids.set(p, (kids.get(p) ?? 0) + 1);
  const by = new Map(steps.map((s) => [s.c, s]));
  const task = new Map<string, string>();
  for (const s of steps) {
    const p = s.parents.length === 1 ? by.get(s.parents[0]) : undefined;
    const same = p && p.c !== from && p.parents.length === 1 && kids.get(p.c) === 1 && s.time - p.time <= TASK_GAP;
    task.set(s.c, same ? task.get(p.c)! : s.c);
  }
  return task;
}

/** Идёт по потомкам from до вершин и считает судьбу каждой пары. Подпись стороны — `файл:строка` снимка. */
export function walk(root: string, pairs: Pair[], from: string, tips: string[]) {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 29 });
  const start = git("rev-parse", from).trim();
  const steps: Step[] = git("rev-list", "--ancestry-path", "--reverse", "--topo-order", "--parents", "--timestamp", ...tips, `^${start}`)
    .trim().split("\n").filter(Boolean)
    .map((l) => {
      const [t, c, ...parents] = l.split(" ");
      return { c, parents, time: +t };
    });
  const task = tasks(steps, start);

  const trees = new Map<string, Map<string, string>>();
  const tree = (c: string) => {
    let t = trees.get(c);
    if (!t) {
      t = new Map();
      for (const l of git("-c", "core.quotePath=false", "ls-tree", "-r", c).split("\n")) {
        const m = l.match(/^\d+ blob (\w+)\t(.*)$/);
        if (m && CODE.test(m[2]) && !TEST.test(m[2])) t.set(m[2], m[1]);
      }
      trees.set(c, t);
    }
    return t;
  };
  const parsed = new Map<string, Fn[]>();
  const fns = (path: string, blob: string) => {
    const key = `${blob}${path.slice(path.lastIndexOf("."))}`;
    let list = parsed.get(key);
    if (!list) {
      const out: Fn[] = (list = []);
      eachFunction(ts, path, git("cat-file", "blob", blob), (n: any, sf: any, name: string | null, line: number) => out.push({ name, line, ...lexemes(n, sf) }));
      parsed.set(key, list);
    }
    return list;
  };

  // где сторона лежит на каждом коммите окна
  const first = new Map<string, Spot>();
  for (const side of new Set(pairs.flatMap((p) => [p.fa, p.fb]))) {
    const at = side.lastIndexOf(":");
    const path = side.slice(0, at), line = +side.slice(at + 1);
    const blob = tree(start).get(path);
    const i = blob ? fns(path, blob).findIndex((f) => f.line === line) : -1;
    if (i < 0) throw new Error(`снимок не сходится с коммитом ${start}: нет функции ${side}`);
    first.set(side, { path, i });
  }
  const spots = new Map([[start, first]]);
  const edits: Edit[] = [];
  const seen = new Set<string>();
  let mass = 0, merges = 0;

  for (const step of steps) {
    const known = step.parents.filter((p) => spots.has(p));
    if (!known.length) continue;
    const now = tree(step.c);
    const was = tree(known[0]);
    const changed = [...new Set([...now.keys(), ...was.keys()])].filter((f) => now.get(f) !== was.get(f));
    const isMerge = step.parents.length > 1;
    const isMass = changed.length > MASS;
    if (isMerge) merges++;
    else if (isMass) mass++;
    const next = new Map<string, Spot>();
    const parentOf = new Map<string, string>();
    for (const p of [...known].reverse()) for (const [side, spot] of spots.get(p)!) next.set(side, spot), parentOf.set(side, p);
    for (const [side, spot] of [...next]) {
      const parent = parentOf.get(side)!;
      const before = tree(parent).get(spot.path)!, after = now.get(spot.path);
      if (before === after) continue;
      const list = fns(spot.path, before);
      const fn = list[spot.i];
      let moved: Spot | undefined;
      const j = after ? follow(list, fns(spot.path, after))[spot.i] : undefined;
      if (j !== undefined) moved = { path: spot.path, i: j };
      else {
        let score = SAME_FORM;
        for (const f of changed) {
          if (f === spot.path || !now.has(f)) continue;
          fns(f, now.get(f)!).forEach((y, i) => {
            const s = jaccard(form(fn), form(y));
            if (s >= score) (score = s), (moved = { path: f, i });
          });
        }
      }
      if (!moved) {
        next.delete(side);
        continue;
      }
      next.set(side, moved);
      const b = fns(moved.path, now.get(moved.path)!)[moved.i];
      const key = `${side}\u0002${fn.hash}\u0002${b.hash}`;
      if (fn.hash === b.hash || isMerge || isMass || seen.has(key)) continue;
      seen.add(key);
      edits.push({ side, c: step.c, parent, task: task.get(step.c)!, time: step.time, before: fn, after: b, rewrite: jaccard(form(fn), form(b)) < REWRITE });
    }
    spots.set(step.c, next);
  }

  const fnAt = (c: string, side: string) => {
    const spot = spots.get(c)?.get(side);
    return spot && fns(spot.path, tree(c).get(spot.path)!)[spot.i];
  };
  const parentsOf = new Set(steps.flatMap((s) => s.parents));
  const ends = steps.length ? steps.map((s) => s.c).filter((c) => !parentsOf.has(c)) : [start];
  const survives = (side: string) => ends.some((c) => spots.get(c)?.has(side));

  const fates: Fate[] = pairs.map((p) => {
    const all = edits.filter((e) => e.side === p.fa || e.side === p.fb);
    const real = all.filter((e) => !e.rewrite);
    const inTask = (e: Edit) => new Set(all.filter((x) => x.task === e.task).map((x) => x.side)).size;
    const name = (side: string) => (side === p.fa ? p.ka : p.kb);
    const fate: Fate = { ka: p.ka, kb: p.kb, fa: p.fa, fb: p.fb, moved: all.length > 0, sync: new Set(real.filter((e) => inTask(e) > 1).map((e) => e.task)).size, rewrites: all.length - real.length, alone: 0, broken: !survives(p.fa) || !survives(p.fb), episodes: [] };
    const used = new Set<Edit>();
    for (const e of real) {
      if (used.has(e) || inTask(e) > 1) continue;
      const other = e.side === p.fa ? p.fb : p.fa;
      const twinBefore = fnAt(e.parent, other), twinAfter = fnAt(e.c, other);
      if (!twinBefore || !twinAfter) {
        fate.alone++;
        continue;
      }
      const base = { edited: name(e.side), other: name(other), side: e.side, commit: e.c, time: e.time };
      const change = delta(e.before.text, e.after.text);
      const late = real.find((x) => x.side === other && x.task !== e.task && x.time >= e.time && !used.has(x) && jaccard(change, delta(x.before.text, x.after.text)) >= SAME_EDIT);
      if (late) {
        used.add(late);
        fate.episodes.push({ kind: "late", ...base, late: late.c, lagMinutes: Math.round((late.time - e.time) / 60) });
      } else {
        const closer = jaccard(shingles(e.after.text, 3), shingles(twinAfter.text, 3)) > jaccard(shingles(e.before.text, 3), shingles(twinBefore.text, 3));
        fate.episodes.push({ kind: closer ? "closer" : "diverged", ...base });
      }
    }
    return fate;
  });
  return { commits: steps.length, merges, mass, fates, alive: (c: string, side: string) => !!spots.get(c)?.has(side) };
}

const sum = (fates: Fate[], pick: (f: Fate) => number) => fates.reduce((n, f) => n + pick(f), 0);
const episodes = (fates: Fate[], kind: Episode["kind"]) => sum(fates, (f) => f.episodes.filter((e) => e.kind === kind).length);

/** Итог двух снимков — строка журнала. Пары берутся из снимка «до». */
export function count(root: string, before: Snapshot, after: Snapshot) {
  const pairs = [...before.near, ...before.inside.filter((p) => !p.fa.startsWith("scripts/"))];
  const { commits, merges, mass, fates } = walk(root, pairs, before.sha, [after.sha]);
  const row = {
    t: new Date().toISOString(),
    kind: "twins",
    from: before.sha,
    to: after.sha,
    commits,
    merges,
    mass,
    pairs: pairs.length,
    moved: fates.filter((f) => f.moved).length,
    sync: sum(fates, (f) => f.sync),
    late: episodes(fates, "late"),
    diverged: episodes(fates, "diverged"),
    closer: episodes(fates, "closer"),
    rewrites: sum(fates, (f) => f.rewrites),
    broken: fates.filter((f) => f.broken).length,
    forgotten: fates.flatMap((f) => f.episodes.filter((e) => e.kind !== "closer").map(({ kind, edited, other, commit, late }) => ({ kind, edited, other, commit, late }))),
  };
  mkdirSync(home(), { recursive: true });
  appendFileSync(journalFile(), `${JSON.stringify(row)}\n`);
  return row;
}

function main(argv: string[]): void {
  const at = argv.indexOf("--root");
  const root = at >= 0 ? argv[at + 1] : join(here, "..", "..", "..", "..");
  const [before, after] = argv;
  if (!before || !after || at === 0 || at === 1) throw new Error("twins.ts <до> <после> [--root <repo>]");
  console.log(JSON.stringify(count(root, load(before), load(after)), null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
