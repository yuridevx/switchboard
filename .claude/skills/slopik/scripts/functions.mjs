// Функции файла с телом: одно правило имени и порядка для детектора и счётчика близнецов.
export function eachFunction(ts, file, text, see) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isFunctionLike(n) && n.body) {
      const name = n.name?.getText(sf) ?? (ts.isCallExpression(n.parent) && ts.isVariableDeclaration(n.parent.parent) ? n.parent.parent.name.getText(sf) : ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(sf) : null);
      see(n, sf, name, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sf;
}
