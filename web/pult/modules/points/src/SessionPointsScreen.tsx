// Вкладка «Точки» карточки: пометка «в R2», последняя точка и действия, линия и ветки, снятие пометки.
import { useCallback, useEffect, useState } from "react";
import { useApp, type ScreenProps } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { ago, Btn, In, Note, Opts, OptsLabel, Page, PageHead, plural, Sec } from "@switchboard/web-ui";
import { usePoints } from "./context.ts";
import { nameOf, r2Of, say } from "./format.ts";
import { PointDialog } from "./PointDialog.tsx";
import { PointLine } from "./PointLine.tsx";
import { usePointDialog } from "./usePointDialog.ts";

type Tone = { text: string; tone?: "ok" | "bad" };

function StateNote({ note }: { note: Tone }) {
  if (!note.text) return null;
  return (
    <Note tone={note.tone} role="status" data-note="">
      {note.text}
    </Note>
  );
}

/** Снятие пометки: сначала галочка, затем ввод имени. */
function Unmark({ callsign, machine, confirm }: { callsign: string; machine: string; confirm(): Promise<boolean> }) {
  const name = nameOf(callsign);
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <Sec>
      <OptsLabel>
        <input type="checkbox" checked={typed === null} data-act="r2" onChange={() => setTyped(typed === null ? "" : null)} />
        Хранить в R2
      </OptsLabel>
      <Note>Снять — точки сессии удалятся из R2 сразу, без отмены.</Note>
      {typed !== null ? (
        <Sec dlg data-dlg="unmark">
          <b>{`Убрать ${callsign} из R2`}</b>
          <Note>{`Точки и ветки сессии удалятся из R2 сразу; отменить нельзя. Сессия на ${machine} продолжит работу — без точек и переноса.`}</Note>
          <Opts>
            <span>{`Введите имя сессии: ${name}`}</span>
            <In mono data-f="unmark" placeholder={name} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
          </Opts>
          <Opts>
            <Btn onClick={() => setTyped(null)}>Отмена</Btn>
            <Btn bad data-act="unmark" disabled={typed !== name} onClick={() => void confirm().then((gone) => gone && setTyped(null))}>
              Убрать из R2
            </Btn>
          </Opts>
        </Sec>
      ) : null}
    </Sec>
  );
}

export function SessionPointsScreen({ params }: ScreenProps) {
  const app = useApp();
  const points = usePoints();
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  const [note, setNote] = useState<Tone>({ text: "" });
  /** сессия в реестре; появляется с загрузкой линии */
  const [sid, setSid] = useState("");
  /** слово отказа реестра: линии (points.list) или первых слов (points.get) */
  const [refused, setRefused] = useState("");

  const r2 = app.use(() => r2Of(points.session(callsign)));
  const line = app.use(() => points.line(sid));
  const canR2 = app.use(() => !!app.can(machine, "session.r2"));
  const canSave = app.use(() => !!app.can(machine, "points.save"));
  const canRaise = app.use(() => !!app.can(machine, "points.raise"));
  const hasRaisers = app.use(() => points.raisers().length > 0);

  const load = useCallback(async () => {
    const found = await points.sidOf(callsign);
    setSid(found);
    if (found) setRefused(await points.loadLine(found));
  }, [points, callsign]);
  const c = usePointDialog(callsign, sid, () => void load());

  // пометку поставили (roster принёс r2) — загрузить линию; на открытой вкладке — сразу
  const inR2 = !!r2;
  useEffect(() => {
    if (inR2) void load();
  }, [inR2, load]);

  /** Поставить или снять пометку; возврат — запрос прошёл. */
  async function mark(on: boolean) {
    setNote({ text: on ? "Включаю…" : "Удаляю точки…" });
    const r = await points.setR2(callsign, on);
    if (!r.ok) {
      setNote({ text: say(r.error, callsign), tone: "bad" });
      return false;
    }
    if (on) {
      setNote({ text: `Первая точка — №${r.result.point}, только что; дальше Host кладёт их сам.`, tone: "ok" });
      return true;
    }
    if (sid) points.dropLine(sid);
    setSid("");
    setNote({ text: `${r.result.deleted ?? 0} ${plural(r.result.deleted ?? 0, "точка удалена", "точки удалено", "точек удалено")} из R2 — сразу, без отмены. Сессия на ${machine} работает дальше, без точек.`, tone: "ok" });
    return true;
  }

  async function saveNow() {
    setNote({ text: "Сохраняю точку…" });
    const r = await points.savePoint(callsign);
    setNote(r.ok ? { text: `Точка №${r.result.point}${r.result.same ? " — та же, файлы не менялись" : ""}`, tone: "ok" } : { text: say(r.error, callsign), tone: "bad" });
    if (r.ok) await load();
  }

  if (!r2) {
    return (
      <Page>
        <Sec data-r2="off">
          <b>{`${callsign} не в R2`}</b>
          <Note>Точек нет: перенос, копия, откат, смена папки и «пожар» — только у сессий в R2.</Note>
          {canR2 ? (
            <OptsLabel>
              <input type="checkbox" data-act="r2" checked={false} onChange={() => void mark(true)} />
              Хранить в R2
            </OptsLabel>
          ) : null}
          <Note>Включите — Host сразу положит первую точку.</Note>
          <StateNote note={note} />
        </Sec>
      </Page>
    );
  }

  const head = line?.points.find((p) => p.id === line.head);
  return (
    <Page>
      <Sec data-r2="on">
        <PageHead>
          <b>{head ? `Точка ${ago(head.at)} · №${head.id}${head.bytes ? ` · ${(head.bytes / 1048576).toFixed(1).replace(".", ",")} МБ` : ""}` : refused || (sid ? "…" : "Точек ещё нет")}</b>
          {canSave ? <Btn onClick={() => void saveNow()}>Сохранить точку</Btn> : null}
          {canRaise || hasRaisers ? (
            <Btn disabled={!head} onClick={() => c.open("move")}>
              Перенести…
            </Btn>
          ) : null}
          {hasRaisers ? (
            <Btn disabled={!head} onClick={() => c.open("copy")}>
              Скопировать…
            </Btn>
          ) : null}
          {canRaise ? (
            <Btn disabled={!head} data-act="dir" onClick={() => c.open("dir")}>
              Сменить папку…
            </Btn>
          ) : null}
        </PageHead>
        <Note>сохраняются сами: в разговоре новое и ответ кончился — Host кладёт точку сам</Note>
        {r2.error ? <Note tone="bad">{`последняя точка не удалась: ${r2.error}`}</Note> : null}
        {refused && head ? (
          <Note tone="bad" role="alert">
            {refused}
          </Note>
        ) : null}
        <StateNote note={note} />
      </Sec>
      {c.dlg ? <PointDialog d={c.dlg} c={c} callsign={callsign} sid={sid} /> : null}
      {line ? <PointLine line={line} callsign={callsign} open={c.open} /> : null}
      <Unmark callsign={callsign} machine={machine} confirm={() => mark(false)} />
    </Page>
  );
}
