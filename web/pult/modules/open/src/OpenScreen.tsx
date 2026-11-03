// Экран новой сессии: имя, проводник, чипы профиля и модели, задача.
import { useEffect, useRef } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, effortName, profileName as short, useApp } from "@switchboard/web-ui";
import { FolderPane, MachinesPane } from "./Browser.tsx";
import { addrView } from "./form.ts";
import { ModelPop, ProfilePop } from "./Pops.tsx";
import { useOpenForm } from "./useOpenForm.ts";

export function OpenScreen({ params }: ScreenProps) {
  const app = useApp();
  const form = useOpenForm(params);
  const { f, set, start } = form;
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const { isNew } = addrView(f);
  const disabled = f.sending || !f.machine;
  const closePop = () => set({ pop: "" });
  const chip = (kind: "prof" | "model") => () => set({ pop: f.pop === kind ? "" : kind, pq: "" });

  return (
    <div className={"op" + (app.wide ? " wide" : "")}>
      {app.wide ? (
        <div className="op-h">
          <b>Новая сессия</b>
          <button className="op-x" aria-label="Закрыть" onClick={() => app.back()}>
            ✕
          </button>
        </div>
      ) : null}
      <div className="op-body">
        <div className={"op-nm" + (f.nameErr ? " bad" : "")}>
          <label htmlFor="op-name">Имя</label>
          <input
            ref={nameRef}
            id="op-name"
            data-f="name"
            value={f.name}
            required
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
            onInput={(e) => set({ name: e.currentTarget.value.trim(), nameErr: "" })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
            }}
          />
        </div>
        {f.nameErr ? (
          <span className="op-err" role="alert" data-err="name">
            {f.nameErr}
          </span>
        ) : null}
        {app.wide ? (
          <div className="op-brw">
            <div className="op-bm">
              <MachinesPane form={form} />
            </div>
            <FolderPane form={form} />
          </div>
        ) : (
          <div className="op-brw one">
            <FolderPane form={form} />
          </div>
        )}
      </div>
      <div className="op-cmp">
        {f.pop && !app.wide ? <div className="op-shade" onClick={closePop} /> : null}
        {f.pop ? (
          <div className="op-pop" role="dialog" aria-label="Выбор">
            {f.pop === "prof" ? <ProfilePop form={form} /> : <ModelPop form={form} />}
            {app.wide ? null : (
              <Btn pri className="op-done" onClick={closePop}>
                Готово
              </Btn>
            )}
          </div>
        ) : null}
        <div className="op-ctx">
          <button className="op-cx" data-pop="prof" aria-expanded={f.pop === "prof"} disabled={!f.machine} onClick={chip("prof")}>
            <span className="k">Профиль</span>
            <b>{f.profile ? short(f.profile) : "без профиля"}</b>
          </button>
          <button className="op-cx" data-pop="model" aria-expanded={f.pop === "model"} onClick={chip("model")}>
            <b>{f.model || "модель"}</b>
            <span className="k">{[f.effort ? effortName(f.effort) : null, f.slot, f.r2 ? "R2" : null].filter(Boolean).join(" · ")}</span>
          </button>
        </div>
        <textarea
          data-f="text"
          rows={3}
          aria-label="Задача"
          placeholder="Что сделать?"
          value={f.text}
          onInput={(e) => set({ text: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (!disabled) void start();
            }
          }}
        />
        {f.err ? (
          <span className="op-err" role="alert">
            {f.err}
          </span>
        ) : null}
        <div className="op-foot">
          <Btn pri data-act="open" disabled={disabled} onClick={() => void start()}>
            {isNew ? "Создать и открыть" : f.text.trim() ? "Начать" : "Открыть"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
