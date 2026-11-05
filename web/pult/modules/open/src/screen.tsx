// Экран новой сессии: имя, проводник, чипы профиля и модели, задача.
import type { KeyboardEvent } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Area, Btn, effortName, IconBtn, In, profileName, slotWait, useApp } from "@switchboard/web-ui";
import { addrView } from "./address.ts";
import { FolderPane, MachinesPane } from "./browser.tsx";
import { useOpenForm } from "./form.ts";
import { ModelPop, ProfilePop } from "./pops.tsx";

const ctrlEnter = (e: KeyboardEvent) => e.key === "Enter" && (e.ctrlKey || e.metaKey);

export function OpenScreen({ params }: ScreenProps) {
  const app = useApp();
  const form = useOpenForm(params);
  const { f, set, start } = form;
  const { isNew } = addrView(f.addr, f.machine, f.list);
  const disabled = f.sending || !f.machine;
  const closePop = () => set({ pop: "" });
  const chip = (kind: "prof" | "model") => () => set({ pop: f.pop === kind ? "" : kind, pq: "" });

  return (
    <div className={"op" + (app.wide ? " wide" : "")}>
      {app.wide ? (
        <div className="op-h">
          <b>Новая сессия</b>
          <IconBtn className="op-x" aria-label="Закрыть" onClick={() => app.back()}>
            ✕
          </IconBtn>
        </div>
      ) : null}
      <div className="op-body">
        <div className={"op-nm" + (f.nameErr ? " bad" : "")}>
          <label htmlFor="op-name">Имя</label>
          <In
            autoFocus
            id="op-name"
            data-f="name"
            value={f.name}
            required
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
            onInput={(e) => set({ name: e.currentTarget.value.trim(), nameErr: "" })}
            onKeyDown={(e) => {
              if (ctrlEnter(e)) void start();
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
          <Btn className="op-cx" data-pop="prof" aria-expanded={f.pop === "prof"} disabled={!f.machine} onClick={chip("prof")}>
            {f.profile ? <span className="k">Профиль</span> : null}
            <b>{f.profile ? profileName(f.profile) : "без профиля"}</b>
          </Btn>
          <Btn className="op-cx" data-pop="model" aria-expanded={f.pop === "model"} onClick={chip("model")}>
            {f.model ? <b>{f.model}</b> : null}
            <span className="k">{[f.model ? null : "Модель", f.effort ? effortName(f.effort) : null, f.slot || slotWait(f.slots), f.r2 ? "R2" : null].filter(Boolean).join(" · ")}</span>
          </Btn>
        </div>
        <Area
          data-f="text"
          rows={3}
          aria-label="Задача"
          placeholder="Что сделать?"
          value={f.text}
          onInput={(e) => set({ text: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (!ctrlEnter(e)) return;
            e.preventDefault();
            if (!disabled) void start();
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
