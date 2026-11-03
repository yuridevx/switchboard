// План машины сбоку: части, версии, закрепление, включение.
import { useState } from "react";
import { Btn, In, M, Note, Opts, PageHead, Sec, useApp } from "@switchboard/web-ui";
import { useSettings } from "./context.ts";
import { NoteOf } from "./parts.tsx";
import { cellOf, machineParts, planOf, short, stableOf, versionsOf } from "./rules.ts";

/** Часть в плане машины. Введённая версия живёт в поле. */
function PlanPart({ m, p }: { m: string; p: string }) {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(settings.releaseData);
  const [version, setVersion] = useState("");
  const c = cellOf(d, m, p);
  if (!c) return null;
  const stable = stableOf(d, p);
  const plan = planOf(d, m)[p];
  const pinned = plan?.pin;
  const choices = [...new Set([...versionsOf(d, p, 4), pinned].filter((v): v is string => !!v && v !== stable))];
  const off = plan?.on === false;
  return (
    <div className="st-part" data-part={p}>
      <PageHead>
        <b className="st-grow">{p}</b>
        <span className={`st-cell ${c.k}`}>{c.t}</span>
      </PageHead>
      {c.why ? <Note tone="bad">{c.why}</Note> : null}
      {stable || choices.length ? (
        <Opts>
          {stable ? (
            <Btn aria-pressed={pinned ? "false" : "true"} onClick={() => void settings.pin(m, p, null)}>
              {`stable ${short(stable)}`}
            </Btn>
          ) : null}
          {choices.map((v) => (
            <Btn key={v} aria-pressed={pinned === v ? "true" : "false"} onClick={() => void settings.pin(m, p, v)}>
              {`📌 ${short(v)}`}
            </Btn>
          ))}
          <In mono className="st-ver" placeholder="версия" aria-label={`Версия ${p}`} value={version} onInput={(e) => setVersion(e.currentTarget.value)} />
          <Btn
            onClick={() => {
              const v = version.trim();
              if (v) void settings.pin(m, p, v);
            }}
          >
            Закрепить
          </Btn>
        </Opts>
      ) : null}
      {p === "keeper" ? null : (
        <Opts>
          <Btn role="switch" aria-checked={off ? "false" : "true"} aria-pressed={off ? "false" : "true"} onClick={() => void settings.togglePart(m, p)}>
            {off ? "выключена" : "включена"}
          </Btn>
        </Opts>
      )}
    </div>
  );
}

export function MachinePlan({ m }: { m: string }) {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(settings.releaseData);
  const st = d.kst[m];
  return (
    <Sec className="st-side" data-plan={m}>
      <PageHead>
        <M className="st-grow">
          <b>{`@${m}`}</b>
        </M>
        {st && !("error" in st) && st.os ? <Note>{st.os}</Note> : null}
        <Btn aria-label="Закрыть" onClick={() => settings.pickMachine(null)}>
          ✕
        </Btn>
      </PageHead>
      <Note>{`план rev ${st && !("error" in st) ? (st.rev ?? 0) : "—"}${d.online.includes(m) ? "" : " · не на связи"}`}</Note>
      {machineParts(d)
        .filter((p) => cellOf(d, m, p))
        .map((p) => (
          <PlanPart key={p} m={m} p={p} />
        ))}
      <NoteOf k="rel" />
    </Sec>
  );
}
