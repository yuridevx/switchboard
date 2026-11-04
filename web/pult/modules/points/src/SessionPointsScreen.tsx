// Вкладка «Точки» карточки: пометка «в R2», последняя точка и действия, линия и ветки, снятие пометки.
import { useCallback, useEffect, useState } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { ago, Btn, Check, In, Note, Opts, OptsLabel, Outcome, Page, PageHead, plural, Sec, useApp, useOutcome } from "@switchboard/web-ui";
import { PointDialog } from "./PointDialog.tsx";
import { PointLine } from "./PointLine.tsx";
import { usePoints } from "./store.ts";
import { usePointDialog } from "./usePointDialog.ts";
import { nameOf, r2Of, refusal } from "./words.ts";

/** Снятие пометки: сначала галочка, затем ввод имени. */
function Unmark({ callsign, machine, confirm }: { callsign: string; machine: string; confirm(): Promise<boolean> }) {
  const name = nameOf(callsign);
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <Sec>
      <OptsLabel>
        <Check checked={typed === null} data-act="r2" onChange={() => setTyped(typed === null ? "" : null)} />
        Хранить в R2
      </OptsLabel>
      <Note>Снять — точки сессии удалятся из R2 сразу, без отмены.</Note>
      {typed === null ? null : (
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
      )}
    </Sec>
  );
}

export function SessionPointsScreen({ params }: ScreenProps) {
  const app = useApp();
  const points = usePoints();
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  const [notes, note] = useOutcome();
  /** sid сессии в реестре: появляется с загрузкой линии */
  const [sid, setSid] = useState("");
  /** слово отказа реестра о линии или первых словах */
  const [refused, setRefused] = useState("");

  const r2 = app.use(() => r2Of(points.session(callsign)));
  const line = app.use(() => points.line(sid));
  const canMark = app.use(() => !!app.can(machine, "session.r2"));
  const canSave = app.use(() => !!app.can(machine, "points.save"));
  const canRaise = app.use(() => !!app.can(machine, "points.raise"));
  const hasRaisers = app.use(() => points.raisers().length > 0);

  const load = useCallback(async () => {
    const found = await points.sidOf(callsign);
    setSid(found);
    // реестр не ответил — слово на месте точек, а не «Точек ещё нет»
    const word = points.refused();
    setRefused(found ? await points.loadLine(found) : word && `points.list: ${word}`);
  }, [points, callsign]);
  const dialog = usePointDialog(callsign, sid, () => void load());

  // пометку поставили: roster принёс r2 — загрузить линию
  const inR2 = !!r2;
  useEffect(() => {
    if (inR2) void load();
  }, [inR2, load]);

  async function setMark(on: boolean): Promise<boolean> {
    note("point", on ? "Включаю…" : "Удаляю точки…");
    const r = await points.setR2(callsign, on);
    if (!r.ok) {
      note("point", refusal(r.error, callsign), "bad");
      return false;
    }
    if (on) {
      note("point", typeof r.result.point === "number" ? `Первая точка — №${r.result.point}, только что; дальше Host кладёт их сам.` : "Первая точка — на первом конце хода.", "ok");
      return true;
    }
    if (sid) points.dropLine(sid);
    setSid("");
    const deleted = r.result.deleted ?? 0;
    note("point", `${deleted} ${plural(deleted, "точка удалена", "точки удалено", "точек удалено")} из R2 — сразу, без отмены. Сессия на ${machine} работает дальше, без точек.`, "ok");
    return true;
  }

  async function saveNow() {
    note("point", "Сохраняю точку…");
    const r = await points.save(callsign);
    if (!r.ok) return note("point", refusal(r.error, callsign), "bad");
    note("point", `Точка №${r.result.point}${r.result.same ? " — та же, файлы не менялись" : ""}`, "ok");
    await load();
  }

  if (!r2) {
    return (
      <Page>
        <Sec data-r2="off">
          <b>{`${callsign} не в R2`}</b>
          <Note>Точек нет: перенос, копия, откат, смена папки и «пожар» — только у сессий в R2.</Note>
          {canMark ? (
            <OptsLabel>
              <Check data-act="r2" checked={false} onChange={() => void setMark(true)} />
              Хранить в R2
            </OptsLabel>
          ) : null}
          <Note>Включите — Host сразу положит первую точку.</Note>
          <Outcome note={notes.point} data-note="" />
        </Sec>
      </Page>
    );
  }

  const head = line?.points.find((p) => p.id === line.head);
  const size = head?.bytes ? ` · ${(head.bytes / 1048576).toFixed(1).replace(".", ",")} МБ` : "";
  return (
    <Page>
      <Sec data-r2="on">
        <PageHead>
          <b>{head ? `Точка ${ago(head.at)} · №${head.id}${size}` : refused || (sid ? "…" : "Точек ещё нет")}</b>
          {canSave ? <Btn onClick={() => void saveNow()}>Сохранить точку</Btn> : null}
          {canRaise || hasRaisers ? (
            <Btn disabled={!head} onClick={() => dialog.open("move")}>
              Перенести…
            </Btn>
          ) : null}
          {hasRaisers ? (
            <Btn disabled={!head} onClick={() => dialog.open("copy")}>
              Скопировать…
            </Btn>
          ) : null}
          {canRaise ? (
            <Btn disabled={!head} data-act="dir" onClick={() => dialog.open("dir")}>
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
        <Outcome note={notes.point} data-note="" />
      </Sec>
      {dialog.current ? <PointDialog d={dialog.current} c={dialog} callsign={callsign} sid={sid} /> : null}
      {line ? <PointLine line={line} callsign={callsign} open={dialog.open} /> : null}
      <Unmark callsign={callsign} machine={machine} confirm={() => setMark(false)} />
    </Page>
  );
}
