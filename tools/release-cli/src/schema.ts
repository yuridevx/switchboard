// Схема входа инструмента MCP из типа запроса в contract.ts модуля: поля запроса описаны в одном месте — в типе.
// Конверт кадра (type, id, v, to, key, from) в схему не идёт: его ставит сервер MCP. Описание поля — его комментарий /** */.
import { join } from "node:path";
import ts from "typescript";

const ENVELOPE = new Set(["type", "id", "v", "to", "key", "from"]);
type Schema = Record<string, unknown>;

/** JSON Schema типа type из contract.ts папки dir; omit — поля, которых в схеме нет. Типа нет — ошибка упаковки. */
export function inputSchema(dir: string, type: string, omit: string[] = []): Schema {
  const file = join(dir, "contract.ts");
  // запрос — кадр JSON: без @types из node_modules и DOM; программа строится вчетверо быстрее (9 инструментов: 7,0 → 1,7 с), схемы те же
  const program = ts.createProgram([file], { strict: true, noEmit: true, types: [], lib: ["lib.es2022.d.ts"], allowImportingTsExtensions: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file)!;
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find((s) => s.name === type);
  if (!symbol) throw new Error(`tool: типа ${type} нет в ${file}`);
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const schema = toSchema(checker, checker.getDeclaredTypeOfSymbol(target), new Set([...ENVELOPE, ...omit]));
  return { ...schema, additionalProperties: false };
}

function toSchema(checker: ts.TypeChecker, t: ts.Type, skip = new Set<string>()): Schema {
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
  if (t.flags & ts.TypeFlags.StringLiteral) return { const: (t as ts.StringLiteralType).value };
  if (t.flags & ts.TypeFlags.NumberLiteral) return { const: (t as ts.NumberLiteralType).value };
  if (t.flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(t) === "true" };
  if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) return { type: "string" };
  if (t.flags & ts.TypeFlags.Number) return { type: "number" };
  if (t.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (t.flags & ts.TypeFlags.Null) return { type: "null" };
  if (t.isUnion()) {
    const parts = t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined)).map((x) => toSchema(checker, x));
    if (parts.length === 1) return parts[0];
    if (parts.every((p) => "const" in p)) return { enum: parts.map((p) => p.const) };
    return { anyOf: parts };
  }
  if (checker.isArrayType(t)) return { type: "array", items: toSchema(checker, checker.getTypeArguments(t as ts.TypeReference)[0]) };
  if (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
    const properties: Schema = {};
    const required: string[] = [];
    for (const p of checker.getPropertiesOfType(t)) {
      if (skip.has(p.name)) continue;
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const pt = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getDeclaredTypeOfSymbol(p);
      const about = ts.displayPartsToString(p.getDocumentationComment(checker));
      properties[p.name] = about ? { ...toSchema(checker, pt), description: about } : toSchema(checker, pt);
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }
    const index = checker.getIndexTypeOfType(t, ts.IndexKind.String);
    return { type: "object", properties, ...(required.length ? { required } : {}), ...(index ? { additionalProperties: toSchema(checker, index) } : {}) };
  }
  return {};
}
