// Дифф правки: строки «−» и «+» цветом, длинные общие куски свёрнуты; счёт «+N −M» для шапки. Считается один раз на вход инструмента.
import { useMemo } from "react";
import { diffLines, type Change } from "diff";
import type { Tool } from "../../state/types.ts";

export type Hunk = { old?: string; new?: string };
/** Общий кусок длиннее стольких строк свёрнут до двух в начале и двух в конце. */
const FOLD = 6;

/** Куски правки: Edit — один, MultiEdit — по правке, Write и ячейка блокнота — всё новое. */
export function hunksOf(t: Tool): Hunk[] {
  const i = t.input;
  switch (t.name) {
    case "MultiEdit":
      return (i.edits ?? []).map((e) => ({ old: e.old_string, new: e.new_string }));
    case "Write":
      return [{ old: "", new: i.content }];
    case "NotebookEdit":
      return [{ old: "", new: i.new_source }];
    default:
      return [{ old: i.old_string, new: i.new_string }];
  }
}
const changes = (h: Hunk): Change[] => diffLines(h.old ?? "", h.new ?? "");
const linesOf = (s: string) => s.replace(/\n$/, "").split("\n");

function HunkView({ h }: { h: Hunk }) {
  const cs = useMemo(() => changes(h), [h.old, h.new]);
  return (
    <div className="chat-diff">
      {cs.flatMap((c, j) => {
        const ls = linesOf(c.value);
        const shown = !c.added && !c.removed && ls.length > FOLD ? [...ls.slice(0, 2), `⋯ ${ls.length - 4} без изменений`, ...ls.slice(-2)] : ls;
        return shown.map((l, n) => (
          <div key={`${j}-${n}`} className={c.added ? "add" : c.removed ? "del" : "same"}>
            <i>{c.added ? "+" : c.removed ? "−" : " "}</i>
            <span>{l}</span>
          </div>
        ));
      })}
    </div>
  );
}

export function Diff({ t }: { t: Tool }) {
  const hunks = hunksOf(t);
  return (
    <>
      {hunks.map((h, k) => (
        <HunkView key={k} h={h} />
      ))}
    </>
  );
}

/** «+3 −1»: добавлено и убрано строк. */
export function DiffCount({ t }: { t: Tool }) {
  const [added, removed] = useMemo(() => {
    let a = 0;
    let r = 0;
    for (const c of hunksOf(t).flatMap(changes)) {
      if (c.added) a += linesOf(c.value).length;
      if (c.removed) r += linesOf(c.value).length;
    }
    return [a, r];
  }, [t]);
  return (
    <span className="chat-count">
      <b>{`+${added}`}</b> <s>{`−${removed}`}</s>
    </span>
  );
}
