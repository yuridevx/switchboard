// Мера сноса: токены и цикломатическая сложность вместо строк; одна на все границы и на карту.
import ts from "typescript";

export const CODE = /\.(ts|tsx|mts|mjs|js|go|css)$/;
export const TEST = /(\/test\/|\/tests\/|\/stand\/|\.test\.|\.spec\.|_test\.go$)/;

export type Fn = { name: string; file: string; complexity: number; lines: number };

const isGo = (file: string) => file.endsWith(".go");
const kindOf = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") || file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** Токены без комментариев: у TypeScript — листья разбора (голый сканер не знает, где кончается подстановка шаблона и начинается регулярка), у остального — слова, числа, строки и знаки. */
export function tokensOf(file: string, text: string): number {
  if (!/\.(ts|tsx|mts|mjs|js)$/.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "").match(/[\p{L}_][\p{L}\p{N}_-]*|\d[\d.]*|"[^"\n]*"|`[^`]*`|\S/gu)?.length ?? 0;
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  let n = 0;
  const walk = (node: ts.Node) => {
    if (ts.isJSDoc(node)) return;
    if (ts.isToken(node)) n += node.kind === ts.SyntaxKind.EndOfFileToken ? 0 : 1;
    else node.getChildren(source).forEach(walk);
  };
  walk(source);
  return n;
}

const BRANCH = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);
const LOGIC = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

const nameOf = (n: ts.Node) => {
  const owner = ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).name ? (n as ts.FunctionLikeDeclaration).name : ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) ? n.parent.name : undefined;
  return owner?.getText() ?? "(без имени)";
};

/** Функции файла со сложностью: 1 плюс ветвления; вложенная считается отдельно. */
export function functionsOf(file: string, text: string): Fn[] {
  if (isGo(file)) {
    return text.split(/^(?=func )/m).filter((part) => part.startsWith("func ")).map((part) => ({
      name: /^func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(part)?.[1] ?? "(без имени)",
      file,
      complexity: 1 + (part.match(/\b(if|for|case)\b|&&|\|\|/g)?.length ?? 0),
      lines: part.trimEnd().split("\n").length,
    }));
  }
  if (!/\.(ts|tsx|mts|mjs|js)$/.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  const out: Fn[] = [];
  const count = (n: ts.Node): number => {
    let c = BRANCH.has(n.kind) || (ts.isBinaryExpression(n) && LOGIC.has(n.operatorToken.kind)) ? 1 : 0;
    ts.forEachChild(n, (k) => {
      if (ts.isFunctionLike(k)) visit(k);
      else c += count(k);
    });
    return c;
  };
  const visit = (n: ts.Node) => {
    if (!ts.isFunctionLike(n)) return void ts.forEachChild(n, visit);
    const start = source.getLineAndCharacterOfPosition(n.getStart()).line;
    const end = source.getLineAndCharacterOfPosition(n.getEnd()).line;
    out.push({ name: nameOf(n), file, complexity: 1 + count(n), lines: end - start + 1 });
  };
  visit(source);
  return out;
}

/** Случаи тестов: it и test, в том числе each и skipIf, у Go — Test-функции. Строки таблиц each не раскрываются. */
export const casesOf = (text: string) => (text.match(/(^|\s)(it|test)(\.each\(|\.skipIf\([^)]*\)\(|\()/g)?.length ?? 0) + (text.match(/^func Test/gm)?.length ?? 0);
