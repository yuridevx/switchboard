// Компоненты набора: один компонент — один класс основания. Лишние свойства (data-*, aria-*, обработчики) идут на элемент.
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { at, LIMIT_BAD, LIMIT_WARN, type Tone } from "./format.ts";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** Кнопка: pri — главная, bad — опасная, dash — необязательная. */
export function Btn({ pri, bad, dash, className, ...p }: ComponentProps<"button"> & { pri?: boolean; bad?: boolean; dash?: boolean }) {
  return <button {...p} className={cx("sb-b", pri && "pri", bad && "bad", dash && "dash", className)} />;
}

/** Ссылка в виде кнопки. */
export function LinkBtn({ pri, className, ...p }: ComponentProps<"a"> & { pri?: boolean }) {
  return <a {...p} className={cx("sb-b", pri && "pri", className)} />;
}

/** Широкая главная кнопка экрана. */
export function Cta({ className, ...p }: ComponentProps<"button">) {
  return <button {...p} className={cx("sb-cta", className)} />;
}

/** Поле ввода: mono — моноширинное. */
export function In({ mono, className, ...p }: ComponentProps<"input"> & { mono?: boolean }) {
  return <input {...p} className={cx("sb-in", mono && "m", className)} />;
}

/**
 * Поле с фиксацией: текст — своё состояние, значение уходит наружу по Enter и при уходе с поля, только если изменилось.
 * Esc возвращает прежнее. Новое значение снаружи заменяет текст.
 */
export function CommitIn({ value, onCommit, onCancel, onBlur, onKeyDown, ...p }: Omit<ComponentProps<typeof In>, "value" | "defaultValue" | "onInput"> & { value: string; onCommit(text: string): void; onCancel?(): void }) {
  const [text, setText] = useState(value);
  const [outer, setOuter] = useState(value);
  /** последнее отправленное: Enter и следующий уход с поля — одна фиксация */
  const [sent, setSent] = useState(value);
  // значение снаружи изменилось: поправка при рисовании, эффект не нужен
  if (outer !== value) {
    setOuter(value);
    setText(value);
    setSent(value);
  }
  const commit = () => {
    if (text === sent) return;
    setSent(text);
    onCommit(text);
  };
  return (
    <In
      {...p}
      value={text}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setText(sent);
          onCancel?.();
        }
        onKeyDown?.(e);
      }}
    />
  );
}

/** Многострочное поле. */
export function Area({ mono, className, ...p }: ComponentProps<"textarea"> & { mono?: boolean }) {
  return <textarea {...p} className={cx("sb-in", mono && "m", className)} />;
}

/** Выпадающий список. */
export function Sel({ className, ...p }: ComponentProps<"select">) {
  return <select {...p} className={cx("sb-in", className)} />;
}

/** Строка пояснения или отказа: tone — цвет. */
export function Note({ tone, className, ...p }: ComponentProps<"div"> & { tone?: "ok" | "bad" | "wait" }) {
  return <div {...p} className={cx("sb-note", tone, className)} />;
}

/** То же внутри строки текста. */
export function Hint({ tone, className, ...p }: ComponentProps<"span"> & { tone?: "ok" | "bad" | "wait" }) {
  return <span {...p} className={cx("sb-note", tone, className)} />;
}

/** Команда или адрес, который копируют. */
export function Cmd({ className, ...p }: ComponentProps<"code">) {
  return <code {...p} className={cx("sb-cmd", className)} />;
}

/** Пилюля состояния: conn — с лампой. */
export function Pill({ tone, conn, className, ...p }: ComponentProps<"span"> & { tone?: Tone; conn?: boolean }) {
  return <span {...p} className={cx("sb-pill", tone, conn && "conn", className)} />;
}

/** Лампа состояния: kind — busy, wait, idle, stop, bad, gone. */
export function Dot({ kind, className, ...p }: ComponentProps<"span"> & { kind?: string }) {
  return <span {...p} className={cx("sb-dot", kind, className)} />;
}

/** Счётчик: wait — ждущий цвет. */
export function Badge({ wait, className, ...p }: ComponentProps<"span"> & { wait?: boolean }) {
  return <span {...p} className={cx("sb-badge", wait && "wait", className)} />;
}

/** Страница широкого вида: прокрутка и отступы. */
export function Page({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cx("sb-page", className)} />;
}

/** Тело экрана узкого вида: прокрутка и отступы. */
export function Pad({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cx("sb-pad", className)} />;
}

/** Заголовок страницы: заголовок и справа действия. */
export function PageHead({ title, children, className, ...p }: Omit<ComponentProps<"div">, "title"> & { title?: ReactNode }) {
  return (
    <div {...p} className={cx("sb-ph", className)}>
      {title !== undefined ? <h2>{title}</h2> : null}
      {children}
    </div>
  );
}

/** Раздел страницы: dlg — диалог; tone — цвет. */
export function Sec({ dlg, tone, className, ...p }: ComponentProps<"section"> & { dlg?: boolean; tone?: "ok" | "bad" | "wait" }) {
  return <section {...p} className={cx("sb-sec", dlg && "dlg", tone, className)} />;
}

/** Подпись раздела. */
export function H4({ className, ...p }: ComponentProps<"h4">) {
  return <h4 {...p} className={cx("sb-h4", className)} />;
}

/** Строка «подпись — значение». */
export function Row({ label, children, className, ...p }: ComponentProps<"div"> & { label: ReactNode }) {
  return (
    <div {...p} className={cx("sb-row", className)}>
      <span>{label}</span>
      {children}
    </div>
  );
}

/** Ряд кнопок и значений. */
export function Opts({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cx("sb-opts", className)} />;
}

/** Ряд подписи и поля выбора: нажатие на подпись выбирает. */
export function OptsLabel({ className, ...p }: ComponentProps<"label">) {
  return <label {...p} className={cx("sb-opts", className)} />;
}

/** Ряд значений внутри строки текста. */
export function OptsInline({ className, ...p }: ComponentProps<"span">) {
  return <span {...p} className={cx("sb-opts", className)} />;
}

/** Группа выбора в панели настроек: подпись и ряд кнопок-переключателей. */
export function Choices({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="vw-g">
      <span className="vw-t">{title}</span>
      <div className="vw-c">{children}</div>
    </div>
  );
}

/** Моноширинный текст. */
export function M({ className, ...p }: ComponentProps<"span">) {
  return <span {...p} className={cx("sb-m", className)} />;
}

/** Полоса расхода: value — доля 0…100; warn, bad — цвет. */
export function Meter({ value, warn, bad, className, ...p }: ComponentProps<"span"> & { value: number; warn?: boolean; bad?: boolean }) {
  return (
    <span {...p} className={cx("sb-barw", warn && "warn", bad && "bad", className)}>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}

/** Строка окна лимита: подпись, полоса, процент и время сброса; пороги цвета — одни на все экраны. used — доля 0…1. */
export function LimitRow({ label, used, resets, ...p }: ComponentProps<"div"> & { label: ReactNode; used: number; resets?: number }) {
  const pct = Math.round(used * 100);
  return (
    <div {...p}>
      <span>{label}</span>
      <Meter value={Math.min(100, pct)} bad={pct >= LIMIT_BAD} warn={pct < LIMIT_BAD && pct >= LIMIT_WARN} />
      <em>{`${pct} %${resets ? ` · до ${at(resets)}` : ""}`}</em>
    </div>
  );
}

/** Итог действия одной строкой: пусто — строки нет. */
export function Outcome({ note, ...p }: ComponentProps<"div"> & { note?: { text: string; tone?: "ok" | "bad" | "wait" | "" } }) {
  if (!note?.text) return null;
  return (
    <Note role={note.tone === "bad" ? "alert" : "status"} {...p} tone={note.tone || undefined}>
      {note.text}
    </Note>
  );
}

/** Карточка итога: хорошо. */
export function OkCard({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cx("sb-okc", className)} />;
}

/** Карточка итога: ждёт. */
export function WaitCard({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cx("sb-waitc", className)} />;
}

/** Карточка итога: отказ. */
export function BadCard({ className, ...p }: ComponentProps<"div">) {
  return <div {...p} className={cx("sb-badc", className)} />;
}

/**
 * Выбор одного из многих: выбранный и ближние (машины проекта) — кнопками, остальные — списком «ещё N…».
 * select — свойства списка (data-f), button — свойства кнопки значения.
 */
export function PickOne({ all, near, cur, on, select, button }: { all: string[]; near: string[]; cur: string; on(v: string): void; select?: ComponentProps<"select"> & Record<`data-${string}`, unknown>; button?(v: string): ComponentProps<"button"> & Record<`data-${string}`, unknown> }) {
  const shown = all.filter((v) => v === cur || near.includes(v));
  const far = all.filter((v) => !shown.includes(v));
  return (
    <>
      {shown.map((v) => (
        <Btn key={v} aria-pressed={v === cur ? "true" : "false"} {...button?.(v)} onClick={() => on(v)}>
          {v}
        </Btn>
      ))}
      {far.length ? (
        <Sel {...select} value="" onChange={(e) => e.currentTarget.value && on(e.currentTarget.value)}>
          <option value="">{`ещё ${far.length}…`}</option>
          {far.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Sel>
      ) : null}
    </>
  );
}
