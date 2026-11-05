// Компоненты набора: один компонент — один класс основания. Лишние свойства (data-*, aria-*, обработчики) идут на элемент.
import { createElement, useRef, useState, type ComponentProps, type ElementType, type ReactNode } from "react";
import type { OutcomeNote } from "./hooks.ts";
import { LIMIT_BAD, LIMIT_WARN, type Tone } from "./labels.ts";
import { slotWait } from "./sessions.ts";
import { at } from "./time.ts";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");

type Mood = "ok" | "bad" | "wait";

/**
 * Компонент одного класса. marks — свойства, которые становятся классами: true — имя свойства, строка — её значение.
 * attrs — свойства по умолчанию: вызывающий может заменить.
 */
function classed<Tag extends ElementType, Marks extends object = object>(tag: Tag, base: string, marks: Array<keyof Marks & string> = [], attrs: ComponentProps<Tag> | object = {}) {
  return function Part({ className, ...rest }: ComponentProps<Tag> & Marks & { className?: string }) {
    const props: Record<string, unknown> = { ...attrs, ...rest };
    const extra = marks.map((key) => {
      const value = props[key];
      delete props[key];
      return value === true ? key : value;
    });
    return createElement(tag, { ...props, className: cx(base, ...extra, className) });
  };
}

const BUTTON = { type: "button" };

/** Кнопка: pri — главная, bad — опасная, dash — необязательная, ghost — без рамки. */
export const Btn = classed<"button", { pri?: boolean; bad?: boolean; dash?: boolean; ghost?: boolean }>("button", "sb-b", ["pri", "bad", "dash", "ghost"]);
/** Строка или пункт списка и меню: своя разметка внутри, вид — у className места. */
export const RowBtn = classed("button", "sb-rw", [], BUTTON);
/** Кнопка-значок: подпись обязательна. */
export const IconBtn = classed<"button", { "aria-label": string }>("button", "sb-ic", [], BUTTON);
/** Действие текстом: ссылка в строке или полоса. */
export const TextBtn = classed("button", "sb-tx", [], BUTTON);
/** Ссылка в виде кнопки. */
export const LinkBtn = classed<"a", { pri?: boolean; ghost?: boolean }>("a", "sb-b", ["pri", "ghost"]);
/** Широкая главная кнопка экрана. */
export const Cta = classed("button", "sb-cta");
/** Ряд чипов выбора: quiet — невыбранные без заливки. */
export const Chips = classed<"div", { quiet?: boolean }>("div", "sb-chips", ["quiet"]);
/** Многострочное поле. */
export const Area = classed("textarea", "sb-in");
/** Выпадающий список. */
export const Sel = classed("select", "sb-in");
/** Строка пояснения или отказа: tone — цвет. */
export const Note = classed<"div", { tone?: Mood }>("div", "sb-note", ["tone"]);
/** То же внутри строки текста. */
export const Hint = classed<"span", { tone?: Mood }>("span", "sb-note", ["tone"]);
/** Команда или адрес, который копируют. */
export const Cmd = classed("code", "sb-cmd");
/** Пилюля состояния: conn — с лампой. */
export const Pill = classed<"span", { tone?: Tone; conn?: boolean }>("span", "sb-pill", ["tone", "conn"]);
/** Лампа состояния: kind — busy, wait, idle, stop, bad, gone. */
export const Dot = classed<"span", { kind?: string }>("span", "sb-dot", ["kind"]);
/** Счётчик: wait — ждущий цвет. */
export const Badge = classed<"span", { wait?: boolean }>("span", "sb-badge", ["wait"]);
/** Страница широкого вида: прокрутка и отступы. */
export const Page = classed("div", "sb-page");
/** Тело экрана узкого вида: прокрутка и отступы. */
export const Pad = classed("div", "sb-pad");
/** Раздел страницы: dlg — диалог; tone — цвет. */
export const Sec = classed<"section", { dlg?: boolean; tone?: Mood }>("section", "sb-sec", ["dlg", "tone"]);
/** Подпись раздела. */
export const H4 = classed("h4", "sb-h4");
/** Ряд кнопок и значений. */
export const Opts = classed("div", "sb-opts");
/** Ряд подписи и поля выбора: нажатие на подпись выбирает. */
export const OptsLabel = classed("label", "sb-opts");
/** Ряд значений внутри строки текста. */
export const OptsInline = classed("span", "sb-opts");
/** Моноширинный текст. */
export const M = classed("span", "sb-m");
/** Карточка итога: хорошо. */
export const OkCard = classed("div", "sb-okc");
/** Карточка итога: ждёт. */
export const WaitCard = classed("div", "sb-waitc");
/** Карточка итога: отказ. */
export const BadCard = classed("div", "sb-badc");

/** Поле ввода: mono — моноширинное. */
export function In({ mono, className, ...p }: ComponentProps<"input"> & { mono?: boolean }) {
  return <input {...p} className={cx("sb-in", mono && "m", className)} />;
}

/** Заголовок раскрытия: open — раскрыто. */
export function DisclosureBtn({ open, className, ...p }: ComponentProps<"button"> & { open: boolean }) {
  return <button type="button" {...p} className={cx("sb-ds", className)} aria-expanded={open} />;
}

/** Переключатель: on — включён; role можно заменить на checkbox. */
export function Switch({ on, ...p }: ComponentProps<"button"> & { on: boolean }) {
  return <button type="button" role="switch" {...p} aria-checked={on} />;
}

/** Флажок. */
export const Check = (p: Omit<ComponentProps<"input">, "type">) => <input {...p} type="checkbox" />;

/** Чип выбора: on — выбран. */
export function Chip({ on, className, ...p }: ComponentProps<"button"> & { on: boolean }) {
  return <button {...p} className={cx("sb-chip", className)} aria-pressed={on ? "true" : "false"} />;
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

/**
 * Строка выбора слота: при двух слотах и больше. Отмеченный считает slotChoice; один слот — только подпись, если он ждёт сброса.
 * Один компонент на форму новой сессии и окна подъёма точки.
 */
export function SlotPick({ slots, value, on, label = "Слот" }: { slots: Record<string, { wait: number | null }>; value: string; on(slot: string): void; label?: string }) {
  const list = Object.entries(slots);
  if (list.length < 2) {
    const wait = slotWait(slots);
    return wait ? (
      <Note tone="wait" data-slot-wait="">
        {`Слот ${wait}`}
      </Note>
    ) : null;
  }
  return (
    <Row label={label} data-slot-pick="">
      <Chips>
        {list.map(([name, s]) => (
          <Chip key={name} on={value === name} data-slot={name} onClick={() => on(name)}>
            {s.wait ? `${name} · ждёт сброса ${at(s.wait)}` : name}
          </Chip>
        ))}
      </Chips>
    </Row>
  );
}

/** Вкладки: tabs — [ключ, подпись]; вид — у className места. */
export function Tabs<K extends string>({ tabs, cur, pick, ...p }: Omit<ComponentProps<"div">, "role"> & { tabs: ReadonlyArray<readonly [K, ReactNode]>; cur: K; pick(k: K): void }) {
  return (
    <div {...p} role="tablist">
      {tabs.map(([key, label]) => (
        <Btn key={key} role="tab" aria-selected={cur === key ? "true" : "false"} data-tab={key} onClick={() => pick(key)}>
          {label}
        </Btn>
      ))}
    </div>
  );
}

/**
 * Поле с фиксацией: текст — своё состояние, значение уходит наружу по Enter и при уходе с поля, только если изменилось.
 * Esc возвращает прежнее. Новое значение снаружи заменяет текст.
 */
export function CommitIn({ value, onCommit, onCancel, onBlur, onKeyDown, ...p }: Omit<ComponentProps<typeof In>, "value" | "defaultValue" | "onInput"> & { value: string; onCommit(text: string): void; onCancel?(): void }) {
  const [text, setText] = useState(value);
  /** значение снаружи и последнее отправленное: Enter и следующий уход с поля — одна фиксация */
  const [seen, setSeen] = useState({ outer: value, sent: value });
  // значение снаружи изменилось: поправка при рисовании, эффект не нужен
  if (seen.outer !== value) {
    setSeen({ outer: value, sent: value });
    setText(value);
  }
  const commit = () => {
    if (text === seen.sent) return;
    setSeen({ ...seen, sent: text });
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
          setText(seen.sent);
          onCancel?.();
        }
        onKeyDown?.(e);
      }}
    />
  );
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

/** Группа выбора в панели настроек: подпись и ряд кнопок-переключателей. */
export function Choices({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="vw-g">
      <span className="vw-t">{title}</span>
      <Chips quiet>{children}</Chips>
    </div>
  );
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
export function Outcome({ note, ...p }: ComponentProps<"div"> & { note?: OutcomeNote | null }) {
  if (!note?.text) return null;
  return (
    <Note role={note.tone === "bad" ? "alert" : "status"} {...p} tone={note.tone || undefined}>
      {note.text}
    </Note>
  );
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
