// Компоненты набора. Компонент одного класса — строка: тег, класс основания, слова-модификаторы, свойства по умолчанию.
import { useEffect, useState, type ComponentProps, type ComponentPropsWithRef, type JSX, type ReactNode } from "react";
import type { OutcomeNote } from "./hooks.ts";
import { LIMIT_BAD, LIMIT_WARN, type Tone } from "./labels.ts";
import { at } from "./time.ts";

type Mood = "ok" | "bad" | "wait";
type Tag = keyof JSX.IntrinsicElements;

const classes = (...words: unknown[]) => words.filter(Boolean).join(" ") || undefined;

/**
 * Компонент одного класса. mods — имена свойств, которые становятся словами класса: true — само имя, строка — её значение.
 * Лишнее (data-*, aria-*, ref) идёт на элемент.
 */
function part<T extends Tag, M extends object = object>(tag: T, base: string, mods: ReadonlyArray<keyof M & string> = [], defaults?: ComponentProps<T>) {
  return ({ className, ...rest }: ComponentPropsWithRef<T> & M & { className?: string }) => {
    const props: Record<string, unknown> = { ...defaults, ...rest };
    const words = mods.map((m) => {
      const v = props[m];
      delete props[m];
      return v === true ? m : v;
    });
    const El = tag as "div";
    return <El {...props} className={classes(base, ...words, className)} />;
  };
}
const BUTTON = { type: "button" } as const;

/** Кнопка: pri — главная, bad — опасная, dash — необязательная, ghost — без рамки. */
export const Btn = part<"button", { pri?: boolean; bad?: boolean; dash?: boolean; ghost?: boolean }>("button", "sb-b", ["pri", "bad", "dash", "ghost"]);
/** Строка или пункт списка и меню: своя разметка внутри, вид — у className места. */
export const RowBtn = part("button", "sb-rw", [], BUTTON);
/** Кнопка-значок: подпись обязательна. */
export const IconBtn = part<"button", { "aria-label": string }>("button", "sb-ic", [], BUTTON);
/** Действие текстом: ссылка в строке или полоса. */
export const TextBtn = part("button", "sb-tx", [], BUTTON);
/** Ссылка в виде кнопки. */
export const LinkBtn = part<"a", { pri?: boolean; ghost?: boolean }>("a", "sb-b", ["pri", "ghost"]);
/** Широкая главная кнопка экрана. */
export const Cta = part("button", "sb-cta");
/** Ряд чипов выбора: quiet — невыбранные без заливки. */
export const Chips = part<"div", { quiet?: boolean }>("div", "sb-chips", ["quiet"]);
/** Многострочное поле. */
export const Area = part("textarea", "sb-in");
/** Выпадающий список. */
export const Sel = part("select", "sb-in");
/** Строка пояснения или отказа: tone — цвет. */
export const Note = part<"div", { tone?: Mood }>("div", "sb-note", ["tone"]);
/** То же внутри строки текста. */
export const Hint = part<"span", { tone?: Mood }>("span", "sb-note", ["tone"]);
/** Команда или адрес, который копируют. */
export const Cmd = part("code", "sb-cmd");
/** Пилюля состояния: conn — с лампой. */
export const Pill = part<"span", { tone?: Tone; conn?: boolean }>("span", "sb-pill", ["tone", "conn"]);
/** Лампа состояния: kind — busy, wait, idle, stop, bad, gone. */
export const Dot = part<"span", { kind?: string }>("span", "sb-dot", ["kind"]);
/** Счётчик: wait — ждущий цвет. */
export const Badge = part<"span", { wait?: boolean }>("span", "sb-badge", ["wait"]);
/** Страница широкого вида: прокрутка и отступы. */
export const Page = part("div", "sb-page");
/** Тело экрана узкого вида: прокрутка и отступы. */
export const Pad = part("div", "sb-pad");
/** Раздел страницы: dlg — диалог; tone — цвет. */
export const Sec = part<"section", { dlg?: boolean; tone?: Mood }>("section", "sb-sec", ["dlg", "tone"]);
/** Подпись раздела. */
export const H4 = part("h4", "sb-h4");
/** Ряд кнопок и значений. */
export const Opts = part("div", "sb-opts");
/** Ряд подписи и поля выбора: нажатие на подпись выбирает. */
export const OptsLabel = part("label", "sb-opts");
/** Ряд значений внутри строки текста. */
export const OptsInline = part("span", "sb-opts");
/** Моноширинный текст. */
export const M = part("span", "sb-m");
/** Карточка итога: хорошо. */
export const OkCard = part("div", "sb-okc");
/** Карточка итога: ждёт. */
export const WaitCard = part("div", "sb-waitc");
/** Карточка итога: отказ. */
export const BadCard = part("div", "sb-badc");

/** Поле ввода: mono — моноширинное. */
export function In({ mono, className, ...p }: ComponentProps<"input"> & { mono?: boolean }) {
  return <input {...p} className={classes("sb-in", mono && "m", className)} />;
}

/** Заголовок раскрытия: open — раскрыто. */
export function DisclosureBtn({ open, className, ...p }: ComponentProps<"button"> & { open: boolean }) {
  return <button type="button" {...p} aria-expanded={open} className={classes("sb-ds", className)} />;
}

/** Переключатель: on — включён; role можно заменить на checkbox. */
export function Switch({ on, ...p }: ComponentProps<"button"> & { on: boolean }) {
  return <button type="button" role="switch" {...p} aria-checked={on} />;
}

/** Флажок. */
export const Check = (p: Omit<ComponentProps<"input">, "type">) => <input {...p} type="checkbox" />;

/** Чип выбора: on — выбран. */
export function Chip({ on, className, ...p }: ComponentProps<"button"> & { on: boolean }) {
  return <button {...p} aria-pressed={on} className={classes("sb-chip", className)} />;
}

/** Строка «подпись — значение». */
export function Row({ label, children, className, ...p }: ComponentProps<"div"> & { label: ReactNode }) {
  return (
    <div {...p} className={classes("sb-row", className)}>
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
  const names = Object.keys(slots);
  const waits = (name: string) => (slots[name].wait ? ` · ждёт сброса ${at(slots[name].wait!)}` : "");
  if (names.length < 2) {
    if (!names[0] || !slots[names[0]].wait) return null;
    return <Note tone="wait" data-slot-wait="">{`Слот ${names[0]}${waits(names[0])}`}</Note>;
  }
  return (
    <Row label={label} data-slot-pick="">
      <Chips>
        {names.map((name) => (
          <Chip key={name} data-slot={name} on={name === value} onClick={() => on(name)}>
            {name + waits(name)}
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
      {tabs.map(([k, label]) => (
        <Btn key={k} role="tab" aria-selected={k === cur} data-tab={k} onClick={() => pick(k)}>
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
  // что уже зафиксировано: Enter и следующий уход с поля — одна фиксация
  const [fixed, setFixed] = useState(value);
  useEffect(() => {
    setText(value);
    setFixed(value);
  }, [value]);
  const commit = () => {
    if (text === fixed) return;
    setFixed(text);
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
          setText(fixed);
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
    <div {...p} className={classes("sb-ph", className)}>
      {title !== undefined && <h2>{title}</h2>}
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
    <span {...p} className={classes("sb-barw", warn && "warn", bad && "bad", className)}>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}

/** Строка окна лимита: подпись, полоса, процент и время сброса; пороги цвета — одни на все экраны. used — доля 0…1. */
export function LimitRow({ label, used, resets, ...p }: ComponentProps<"div"> & { label: ReactNode; used: number; resets?: number }) {
  const percent = Math.round(used * 100);
  return (
    <div {...p}>
      <span>{label}</span>
      <Meter value={Math.min(percent, 100)} warn={percent >= LIMIT_WARN && percent < LIMIT_BAD} bad={percent >= LIMIT_BAD} />
      <em>{`${percent} %${resets ? ` · до ${at(resets)}` : ""}`}</em>
    </div>
  );
}

/** Итог действия одной строкой: пусто — строки нет. */
export function Outcome({ note, ...p }: ComponentProps<"div"> & { note?: OutcomeNote | null }) {
  if (!note?.text) return null;
  return (
    <Note {...p} role={note.tone === "bad" ? "alert" : "status"} tone={note.tone || undefined}>
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
