// Монорепо как набор: манифесты с фактами кода. Node и парсер берутся при вызове — контракт собирается для страницы и Worker.
import type * as TS from "typescript";
import { order, type Manifest } from "./check.ts";

/** Что считать тестом — одно правило на гейт и меру сноса. */
export const TEST = /(^|\/)(test|tests|stand)\/|\.(test|spec)\.|_test\.go$/;
const CODE = /\.(ts|tsx|mts|mjs|js)$/;
/** Что тест берёт у чужого модуля без uses: вход пакета, контракт, манифест, стенд. */
const OPEN = /^(contract\.ts|module\.json|stand\/.*)?$/;
const NEVER = /^(node_modules|dist|\..*)$/;
/** React на странице — рантайм модуля web-view. */
const VIEW = "@switchboard/web-view";

/** Устройство файла: куда он импортирует и какие привязки Worker зовёт. Комментарии и строки парсер не считает. */
function read(ts: typeof TS, file: string, text: string) {
  const specs: string[] = [];
  const calls: string[] = [];
  const spec = (n: TS.Node | undefined) => {
    if (n && ts.isStringLiteralLike(n)) specs.push(n.text);
  };
  const isEnv = (n: TS.Node) => (ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) && n.name.text) === "env";
  const walk = (n: TS.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) spec(n.moduleSpecifier);
    else if (ts.isExternalModuleReference(n)) spec(n.expression);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) spec(n.argument.literal);
    else if (ts.isCallExpression(n)) {
      const f = n.expression;
      if (f.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(f) && f.text === "require")) spec(n.arguments[0]);
      else if (ts.isPropertyAccessExpression(f) && ts.isPropertyAccessExpression(f.expression) && isEnv(f.expression.expression)) calls.push(`${f.expression.name.text.toLowerCase()}.${f.name.text}`);
    }
    ts.forEachChild(n, walk);
  };
  walk(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return { specs, calls };
}

/** Модули монорепо в порядке зависимостей; `dir` — папка от корня. */
export function loadRepo(root: string) {
  const fs = process.getBuiltinModule("node:fs");
  const ts: typeof TS = process.getBuiltinModule("node:module").createRequire(import.meta.url)("typescript");
  const text = (file: string) => fs.readFileSync(`${root}/${file}`, "utf8");
  const files = fs.globSync("{protocol,tools,workers,os,host,web}/**/*", { cwd: root, exclude: (name) => NEVER.test(name) }).map((f) => f.replaceAll("\\", "/"));
  const found = new Set(files);

  const mods = files.filter((f) => f.endsWith("/module.json") && !TEST.test(f)).map((file) => {
    const dir = file.slice(0, -"/module.json".length);
    const pkg: string | undefined = found.has(`${dir}/package.json`) ? JSON.parse(text(`${dir}/package.json`)).name : undefined;
    const facts = { imports: [] as string[], reach: [] as string[], testReach: [] as string[], rpc: [] as string[] };
    return { provides: {}, uses: {}, config: {}, ...(JSON.parse(text(file)) as Manifest), pkg, dir, ...facts };
  });
  const deepest = [...mods].sort((a, b) => b.dir.length - a.dir.length);
  const moduleAt = (file: string) => deepest.find((m) => file.startsWith(`${m.dir}/`));
  const byPkg = new Map(mods.map((m) => [m.pkg, m]));
  /** Модуль и путь внутри него, куда ведёт импорт; вне модулей — ничей. */
  const target = (spec: string, from: string) => {
    if (spec.startsWith(".")) {
      const file = new URL(spec, `file:///${from}`).pathname.slice(1);
      const owner = moduleAt(file);
      return { owner, path: file.slice((owner?.dir.length ?? 0) + 1) };
    }
    const [scope, name, ...path] = spec.split("/");
    return { owner: byPkg.get(`${scope}/${name}`), path: path.join("/") };
  };

  for (const file of files) {
    const m = moduleAt(file);
    if (!m || !CODE.test(file) || file.endsWith(".d.ts")) continue;
    const { specs, calls } = read(ts, file, text(file));
    const test = TEST.test(file);
    if (!test) m.rpc.push(...calls);
    for (const spec of specs) {
      const { owner, path } = target(spec, file);
      const foreign = owner && owner !== m;
      if (test) {
        if (foreign && found.has(`${owner.dir}/contract.ts`) && !OPEN.test(path)) m.testReach.push(`${owner.name}/${path}`);
      } else if (spec.startsWith("@switchboard/")) m.imports.push(spec);
      else if (/^react(-dom)?(\/|$)/.test(spec)) m.imports.push(VIEW);
      else if (foreign && spec.startsWith(".")) m.reach.push(`${owner.name}/${path}`);
    }
  }
  const sorted = (list: string[]) => [...new Set(list)].sort();
  return order(mods.map((m) => ({ ...m, imports: sorted(m.imports), reach: sorted(m.reach), testReach: sorted(m.testReach), rpc: sorted(m.rpc) })));
}
