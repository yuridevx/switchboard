// Компоненты набора: один компонент — один класс основания; лишние свойства и ref идут на элемент.
import { createElement, useEffect, useRef, type ComponentProps, type ElementType, type ReactNode } from "react";
import { LIMIT_BAD, LIMIT_WARN, type Tone } from "./labels.ts";
import { at, slotWaitText } from "./time.ts";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");

/** Компонент без своих свойств: тег, класс основания и свойства по умолчанию. */
const made =
  <T extends ElementType>(Tag: T, base: string, defaults: object = {}) =>
  ({ className, ...rest }: ComponentProps<T>) =>
    createElement(Tag, { ...defaults, ...rest, className: cx(base, className) });

const BUTTON = { type: "button" };

export const RowBtn = made("button", "sb-rw", BUTTON);
export const IconBtn = made("button", "sb-ic", BUTTON) as (p: ComponentProps<"button"> & { "aria-label": string }) => ReactNode;
export const TextBtn = made("button", "sb-tx", BUTTON);
export const Cta = made("button", "sb-cta");
export const Area = made("textarea", "sb-in");
export const Sel = made("select", "sb-in");
export const Cmd = made("code", "sb-cmd");
export const Page = made("div", "sb-page");
export const Pad = made("div", "sb-pad");
export const H4 = made("h4", "sb-h4");
export const Opts = made("div", "sb-opts");
export const OptsLabel = made("label", "sb-opts");
export const M = made("span", "sb-m");
export const OkCard = made("div", "sb-okc");
export const WaitCard = made("div", "sb-waitc");
export const BadCard = made("div", "sb-badc");

type Look = { pri?: boolean; bad?: boolean; dash?: boolean; ghost?: boolean };
const look = ({ pri, bad, dash, ghost }: Look) => cx(pri && "pri", bad && "bad", dash && "dash", ghost && "ghost");

export const Btn = ({ pri, bad, dash, ghost, className, ...rest }: ComponentProps<"button"> & Look) => <button {...rest} className={cx("sb-b", look({ pri, bad, dash, ghost }), className)} />;
export const LinkBtn = ({ pri, ghost, className, ...rest }: ComponentProps<"a"> & Pick<Look, "pri" | "ghost">) => <a {...rest} className={cx("sb-b", look({ pri, ghost }), className)} />;

export const DisclosureBtn = ({ open, className, ...rest }: ComponentProps<"button"> & { open: boolean }) => <button type="button" aria-expanded={open} {...rest} className={cx("sb-ds", className)} />;

export const Chips = ({ quiet, className, ...rest }: ComponentProps<"div"> & { quiet?: boolean }) => <div {...rest} className={cx("sb-chips", quiet && "quiet", className)} />;
export const Chip = ({ on, className, ...rest }: ComponentProps<"button"> & { on: boolean }) => <button aria-pressed={on} {...rest} className={cx("sb-chip", className)} />;

export const In = ({ mono, className, ...rest }: ComponentProps<"input"> & { mono?: boolean }) => <input {...rest} className={cx("sb-in", mono && "m", className)} />;

export const Note = ({ tone, className, ...rest }: ComponentProps<"div"> & { tone?: Tone }) => <div {...rest} className={cx("sb-note", tone, className)} />;

export const Pill = ({ tone, conn, className, ...rest }: ComponentProps<"span"> & { tone?: Tone; conn?: boolean }) => <span {...rest} className={cx("sb-pill", tone, conn && "conn", className)} />;
export const Dot = ({ kind, className, ...rest }: ComponentProps<"span"> & { kind?: string }) => <span {...rest} className={cx("sb-dot", kind, className)} />;
export const Badge = ({ wait, className, ...rest }: ComponentProps<"span"> & { wait?: boolean }) => <span {...rest} className={cx("sb-badge", wait && "wait", className)} />;

export const PageHead = ({ title, className, children, ...rest }: Omit<ComponentProps<"div">, "title"> & { title?: ReactNode }) => (
  <div {...rest} className={cx("sb-ph", className)}>
    {title !== undefined && <h2>{title}</h2>}
    {children}
  </div>
);

export const Sec = ({ dlg, tone, className, ...rest }: ComponentProps<"section"> & { dlg?: boolean; tone?: Tone }) => <section {...rest} className={cx("sb-sec", dlg && "dlg", tone, className)} />;

export const Row = ({ label, className, children, ...rest }: ComponentProps<"div"> & { label: ReactNode }) => (
  <div {...rest} className={cx("sb-row", className)}>
    <span>{label}</span>
    {children}
  </div>
);

export const Meter = ({ value, warn, bad, className, ...rest }: ComponentProps<"span"> & { value: number; warn?: boolean; bad?: boolean }) => (
  <span {...rest} className={cx("sb-barw", warn && "warn", bad && "bad", className)}>
    <i style={{ width: `${value}%` }} />
  </span>
);

export const Switch = ({ on, ...rest }: ComponentProps<"button"> & { on: boolean }) => <button type="button" role="switch" aria-checked={on} {...rest} />;
export const Check = (p: ComponentProps<"input">) => <input type="checkbox" {...p} />;

export const Tabs = <K extends string>({ tabs, cur, pick, ...rest }: Omit<ComponentProps<"div">, "children"> & { tabs: ReadonlyArray<readonly [K, ReactNode, boolean?]>; cur: K; pick(id: K): void }) => (
  <div {...rest} role="tablist">
    {tabs.map(([id, label, off]) => (
      <Btn key={id} role="tab" aria-selected={id === cur} data-tab={id} disabled={off} onClick={() => pick(id)}>
        {label}
      </Btn>
    ))}
  </div>
);

/** Подтверждение на месте, без окна: что случится — словами до действия. */
export const Confirm = ({ text, act, run, cancel }: { text: string; act: string; run(): void; cancel(): void }) => (
  <div className="sb-confirm" data-confirm="">
    <span>{text}</span>
    <Btn bad data-act="confirm" onClick={run}>
      {act}
    </Btn>
    <Btn data-act="confirm-no" onClick={cancel}>
      Отмена
    </Btn>
  </div>
);

export const Choices = ({ title, children }: { title: ReactNode; children: ReactNode }) => (
  <div className="vw-g">
    <span className="vw-t">{title}</span>
    <Chips quiet>{children}</Chips>
  </div>
);

export type OutcomeNote = { text: string; tone?: "ok" | "bad" | "wait" | "" };

/** Итог действия: нет текста — нет строки. */
export const Outcome = ({ note, ...rest }: Omit<ComponentProps<"div">, "role"> & { note: OutcomeNote | null | undefined }) =>
  note?.text ? (
    <Note {...rest} tone={note.tone} role={note.tone === "bad" ? "alert" : "status"}>
      {note.text}
    </Note>
  ) : null;

/** Поле с фиксацией: Enter и уход с поля фиксируют изменённое один раз, Esc возвращает прежнее. */
export function CommitIn({ value, onCommit, onCancel, onBlur, onKeyDown, ...rest }: Omit<ComponentProps<typeof In>, "value" | "defaultValue"> & { value: string; onCommit(v: string): void; onCancel?(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const fixed = useRef(value);
  useEffect(() => {
    fixed.current = value;
    input.current!.value = value;
  }, [value]);
  const commit = () => {
    const v = input.current!.value;
    if (v === fixed.current) return;
    fixed.current = v;
    onCommit(v);
  };
  return (
    <In
      {...rest}
      ref={input}
      defaultValue={value}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          input.current!.value = fixed.current;
          onCancel?.();
        }
        onKeyDown?.(e);
      }}
    />
  );
}

type LimitProps = ComponentProps<"div"> & { label: ReactNode; used: number; resets?: number };

/** Строка лимита: доля, полоса с порогами и срок. */
export function LimitRow({ label, used, resets, ...rest }: LimitProps) {
  const percent = Math.round(used * 100);
  return (
    <div {...rest}>
      <span>{label}</span>
      <Meter value={Math.min(percent, 100)} warn={percent >= LIMIT_WARN && percent < LIMIT_BAD} bad={percent >= LIMIT_BAD} />
      <em>{`${percent} %${resets ? ` · до ${at(resets)}` : ""}`}</em>
    </div>
  );
}

type Slots = Record<string, { wait: number | null }>;

/** Выбор слота: два и больше — чипы; один ждущий — подпись; один свободный — ничего. */
export function SlotPick({ slots, value, on, label = "Слот" }: { slots: Slots; value: string; on(name: string): void; label?: string }) {
  const names = Object.keys(slots);
  if (names.length < 2) {
    const wait = slots[names[0]]?.wait;
    return wait ? (
      <Note tone="wait" data-slot-wait="">
        {`Слот ${slotWaitText(names[0], wait)}`}
      </Note>
    ) : null;
  }
  return (
    <Row label={label} data-slot-pick="">
      <Chips>
        {names.map((n) => (
          <Chip key={n} on={n === value} data-slot={n} onClick={() => on(n)}>
            {slots[n].wait ? slotWaitText(n, slots[n].wait) : n}
          </Chip>
        ))}
      </Chips>
    </Row>
  );
}

type PickProps = { all: string[]; near: string[]; cur: string; on(v: string): void; select?: ComponentProps<"select"> & Record<`data-${string}`, unknown>; button?(v: string): ComponentProps<"button"> & Record<`data-${string}`, unknown> };

/** Один из многих: выбранный и ближние — кнопками, остальные — списком «ещё N…». */
export function PickOne({ all, near, cur, on, select, button }: PickProps) {
  const shown = all.filter((v) => v === cur || near.includes(v));
  const rest = all.filter((v) => !shown.includes(v));
  return (
    <>
      {shown.map((v) => (
        <Btn key={v} {...button?.(v)} aria-pressed={v === cur} onClick={() => on(v)}>
          {v}
        </Btn>
      ))}
      {rest.length > 0 && (
        <Sel {...select} value="" onChange={(e) => e.target.value && on(e.target.value)}>
          <option value="">{`ещё ${rest.length}…`}</option>
          {rest.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Sel>
      )}
    </>
  );
}
