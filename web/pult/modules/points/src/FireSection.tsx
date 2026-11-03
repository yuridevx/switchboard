// «Пожар»: машины хозяина нет в roster. Плашка на машину и перенос её сессий: по одной, следующая — после ответа на предыдущую; points.save не шлётся.
import { useState } from "react";
import { useApp } from "@switchboard/web-core";
import { Btn, H4, hhmm, M, Note, Opts, plural, Row, Sec } from "@switchboard/web-ui";
import { usePoints } from "./context.ts";
import { folderText, nameOf, say } from "./format.ts";
import { PickMachine } from "./parts.tsx";
import type { CheckResult, FleetSession } from "./store.ts";

type FireRow = { s: FleetSession; dir: string; slot: string; check: CheckResult | null; st: string };
type Fire = { from: string; target: string; rows: FireRow[]; run: boolean; done: number };

function FireDialog({ f, pick, run, close }: { f: Fire; pick(m: string): void; run(): void; close(): void }) {
  const ready = f.rows.every((r) => r.check && !("error" in r.check) && r.check.folder !== "other");
  return (
    <Sec dlg data-dlg="fire">
      <H4>{`Перенести сессии ${f.from} на другую машину`}</H4>
      {f.run ? (
        <Sec tone={f.done === f.rows.length ? "ok" : "wait"} role="status" data-progress={`${f.done}/${f.rows.length}`}>
          <b>{`Перенос с ${f.from} на ${f.target}: ${f.done} из ${f.rows.length} готовы${f.done < f.rows.length && f.rows.some((r) => !r.st || r.st.endsWith("…")) ? " — не закрывайте страницу" : ""}`}</b>
        </Sec>
      ) : (
        <Row label="Куда">
          <PickMachine cur={f.target} callsign={f.rows[0]?.s.callsign ?? undefined} on={pick} />
        </Row>
      )}
      {f.rows.map((r) => (
        <Sec key={r.s.sid} data-row={nameOf(r.s.callsign ?? r.s.sid)}>
          <b>{nameOf(r.s.callsign ?? r.s.sid)}</b>
          <Note>{`точка ${hhmm(r.s.head.at)} · №${r.s.head.id}`}</Note>
          {f.run ? (
            <Note>{r.st}</Note>
          ) : (
            <Opts>
              <Note>{`Слот на ${f.target}: ${r.slot || "без слота"}`}</Note>
              <M>{r.dir}</M>
            </Opts>
          )}
          {f.run ? null : r.check ? "error" in r.check ? <Note tone="bad">{say(r.check.error)}</Note> : <Note>{folderText(r.check, f.target)}</Note> : <Note>проверяю папку…</Note>}
        </Sec>
      ))}
      <Note>Каждая поднимется из своей последней точки, по одной, пока страница открыта. Закроете — оставшиеся ждут на точках, плашка останется.</Note>
      {f.run ? (
        <Opts>
          <Btn onClick={close}>Закрыть</Btn>
        </Opts>
      ) : (
        <Opts>
          <Btn onClick={close}>Отмена</Btn>
          <Btn pri disabled={!ready || !f.target} onClick={run}>{`Перенести ${f.rows.length} из ${f.rows.length} на ${f.target}`}</Btn>
        </Opts>
      )}
    </Sec>
  );
}

export function FireSection({ fires, left }: { fires: Array<[string, FleetSession[]]>; left: Record<string, number> }) {
  const app = useApp();
  const points = usePoints();
  const canRaise = app.use(() => points.raisers().length > 0);
  const [fire, setFire] = useState<Fire | null>(null);

  async function pick(target: string, rows: FireRow[]) {
    setFire((f) => f && { ...f, target });
    const { slots, checks } = await points.probe(target, rows.map((r) => ({ sid: r.s.sid, point: r.s.head.id, dir: r.dir })));
    // выбрали другую машину, пока шёл ответ — он устарел
    setFire((f) => f && f.target === target ? { ...f, rows: f.rows.map((r, i) => ({ ...r, slot: slots ? (slots[0] ?? "") : r.slot, check: checks[i] })) } : f);
  }

  function open(from: string, list: FleetSession[]) {
    const target = points.raisers()[0] ?? "";
    const rows: FireRow[] = list.map((s) => ({ s, dir: s.dir ?? "~", slot: "", check: null, st: "" }));
    setFire({ from, target, rows, run: false, done: 0 });
    void pick(target, rows);
  }

  async function run(f: Fire) {
    setFire((x) => x && { ...x, run: true });
    const setSt = (i: number, st: string, done = 0) => setFire((x) => x && { ...x, done: x.done + done, rows: x.rows.map((r, n) => (n === i ? { ...r, st } : r)) });
    for (const [i, r] of f.rows.entries()) {
      setSt(i, "поднимается…");
      const x = await points.raise({ machine: f.target, sid: r.s.sid, point: r.s.head.id, dir: r.dir, ...(r.slot ? { slot: r.slot } : {}), files: "point" });
      if (x.ok) points.keepProject(r.s.callsign, x.result.callsign);
      setSt(i, x.ok ? `готова — ${x.result.callsign}` : x.error === "not_owner" ? "уже подняли на другой машине" : `не поднялась: ${say(x.error)}`, x.ok ? 1 : 0);
    }
    void points.loadFleet();
  }

  return (
    <>
      {fires.map(([m, list]) => (
        <Sec key={m} tone="bad" data-fire={m}>
          <b>{`${m} не на связи${left[m] ? ` с ${hhmm(left[m])}` : ""} · ${list.length} ${plural(list.length, "сессия ждёт", "сессии ждут", "сессий ждут")} на последних точках`}</b>
          <Note>{`Что ${m} допишет после точек, вернётся веткой, если он появится.`}</Note>
          {!fire && canRaise ? (
            <Opts>
              <Btn pri onClick={() => open(m, list)}>
                Перенести на другую машину…
              </Btn>
            </Opts>
          ) : null}
        </Sec>
      ))}
      {fire ? <FireDialog f={fire} pick={(m) => void pick(m, fire.rows)} run={() => void run(fire)} close={() => setFire(null)} /> : null}
    </>
  );
}
