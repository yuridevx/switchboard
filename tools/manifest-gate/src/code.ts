// Что файл кода импортирует и какие привязки зовёт — по дереву разбора TypeScript: комментарии и строки кодом не считаются.
import type * as TS from "typescript";

let parser: typeof TS | undefined;
/** Парсер грузится при первом чтении файла: странице и Worker контракт нужен без него. */
const typescript = () => (parser ??= process.getBuiltinModule("node:module").createRequire(import.meta.url)("typescript") as typeof TS);

export function readCode(file: string, text: string): { specs: string[]; rpc: string[] } {
  const ts = typescript();
  const specs: string[] = [];
  const rpc: string[] = [];
  const spec = (n?: TS.Node) => {
    if (n && ts.isStringLiteralLike(n)) specs.push(n.text);
  };
  const isEnv = (n: TS.Node) => (ts.isIdentifier(n) && n.text === "env") || (ts.isPropertyAccessExpression(n) && n.name.text === "env");
  const visit = (n: TS.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) spec(n.moduleSpecifier);
    else if (ts.isExternalModuleReference(n)) spec(n.expression);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) spec(n.argument.literal);
    else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) spec(n.arguments[0]);
      else if (ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && isEnv(callee.expression.expression)) {
        const binding = callee.expression.name.text;
        if (/^[A-Z][A-Z0-9_]*$/.test(binding)) rpc.push(`${binding.toLowerCase()}.${callee.name.text}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return { specs, rpc };
}
