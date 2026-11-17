// Выбор модели: один список на всю страницу — каталог Claude и каталоги провайдеров флота, как их отдала служба ключей.
// Поиск — правило «слова → модели» из договора; закреплённые — сверху. Выбор называет сразу провайдера и точную модель: имя каталога — оно же имя в документе сессии.
import { CLAUDE, findModels, keysList, keysModels, type Offer as Found } from "@sb/protocol";
import { InputBase, Popover, TextInput } from "@mantine/core";
import { IconPin, IconPinFilled, IconSearch } from "@tabler/icons-react";
import { useQueries } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useCall, useMyPrefs } from "../common.tsx";
import { claudeKeys } from "../lib/accounts.ts";
import { kilo } from "../lib/time.ts";
import "./session.css";

/** Модель в списке: провайдер (claude или имя ключа флота), имя каталога, название и семейство из каталога; group — заголовок группы. */
export type Offer = Found & { group: string; label: string; window?: number };
export const offerId = (o: { key: string; model: string }) => `${o.key}/${o.model}`;
/** Закреплённые модели — личная настройка: одна на всех устройствах человека. */
export const PINS = "models.pins";
const providerWord = (key: string) => (key === CLAUDE ? "Claude" : key);

/** Каталоги → список: порядок — как отдали провайдеры; группа — провайдер и семейство модели. */
export function offersOf(catalogs: Array<{ key: string; models: Array<{ id: string; name?: string; family?: string; window?: number }> }>): Offer[] {
  return catalogs.flatMap(({ key, models }) => models.map((m): Offer => ({
    key, model: m.id, ...(m.name ? { name: m.name } : {}), ...(m.family ? { family: m.family } : {}),
    // семейство называет каталог; не назвал — модели провайдера идут одной группой
    group: m.family ? `${providerWord(key)} · ${m.family}` : providerWord(key), label: m.name ?? m.id, ...(m.window ? { window: m.window } : {}),
  })));
}

/** Что показать: подходящие словам, закреплённые — первыми, остальные — по группам в порядке каталога. */
export function arrange(offers: Offer[], q: string, pins: string[]): { pinned: Offer[]; groups: Array<{ group: string; list: Offer[] }> } {
  const shown = findModels(q, offers) as Offer[];
  const rest = shown.filter((o) => !pins.includes(offerId(o)));
  return { pinned: shown.filter((o) => pins.includes(offerId(o))), groups: [...new Set(rest.map((o) => o.group))].map((group) => ({ group, list: rest.filter((o) => o.group === group) })) };
}

/** Все модели флота: каталог Claude — если у флота есть аккаунт Claude — и каталог каждого провайдера. */
export function useOffers(): Offer[] {
  const keys = useCall(keysList, {});
  const rows = keys.data?.keys ?? [];
  const names = [...(claudeKeys(rows).length ? [CLAUDE] : []), ...rows.filter((k) => k.protocol !== CLAUDE).map((k) => k.name)];
  const lists = useQueries({ queries: names.map((name) => ({ queryKey: ["keys.models", { name }], queryFn: () => api.call(keysModels, { name }), retry: false, staleTime: 60_000 })) });
  return offersOf(names.map((key, i) => ({ key, models: lists[i]?.data?.models ?? [] })));
}

/** Имя модели для человека: название из каталога, иначе имя каталога. model — имя из документа сессии или из ответа модели. */
export const offerWord = (offers: Offer[], model?: string) => (model ? (offers.find((o) => o.model === model)?.label ?? model) : "модель не выбрана");
/** То же — по прочитанным каталогам флота: имя встаёт, когда каталог ответил. */
export function useModelWord(): (model?: string) => string {
  const offers = useOffers();
  return (model) => offerWord(offers, model);
}

export function ModelPicker({ value, onPick, face, title, field, loud, ask }: { value?: { key?: string; model?: string }; onPick(o: Offer): void; /** что стоит на кнопке */ face: ReactNode; title?: string; /** поле формы, а не значение ряда */ field?: boolean; /** отвечает не та модель, что выбрана */ loud?: boolean; /** «/model слова» из поля ввода: открыть список с этим поиском */ ask?: { n: number; q: string } }) {
  const offers = useOffers();
  const prefs = useMyPrefs();
  const pins = (prefs.values[PINS] as string[] | undefined) ?? [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  // «/model» из поля ввода: кнопка модели в ряду может быть прокручена за край — список открывается у видимой кнопки
  useEffect(() => { if (ask) (button.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }), setQ(ask.q), setOpen(true)); }, [ask?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const { pinned, groups } = arrange(offers, q, pins);
  const first = pinned[0] ?? groups[0]?.list[0];
  const pick = (o: Offer) => (onPick(o), setOpen(false), setQ(""));
  const row = (o: Offer, withProvider: boolean) => {
    const id = offerId(o), on = pins.includes(id), cur = !!value?.model && (value.key ?? CLAUDE) === o.key && value.model === o.model;
    return (
      <div key={id} className={`mp-row${cur ? " cur" : ""}`} role="option" aria-selected={cur} data-offer={id}>
        <button type="button" className="mp-pick" onClick={() => pick(o)}>
          <span className="trunc">{o.label}</span>
          {withProvider && <span className="mp-note">{providerWord(o.key)}</span>}
          {o.window !== undefined && <span className="mp-note">{kilo(o.window)}</span>}
        </button>
        <button type="button" className="mp-pin" aria-pressed={on} aria-label={`${on ? "Открепить" : "Закрепить"} ${o.label}`} title={on ? "Открепить" : "Закрепить"} onClick={() => prefs.save(PINS, on ? pins.filter((p) => p !== id) : [...pins, id])}>{on ? <IconPinFilled size={14} /> : <IconPin size={14} />}</button>
      </div>
    );
  };
  return (
    <Popover opened={open} onChange={setOpen} position={field ? "bottom-start" : "top-start"} width={380} withinPortal trapFocus shadow="md">
      <Popover.Target>
        {field
          ? <InputBase component="button" type="button" label="Модель" pointer onClick={() => setOpen(!open)} aria-haspopup="listbox">{face}</InputBase>
          : <button ref={button} type="button" className={`docval${loud ? " loud" : ""}`} aria-label="Модель" aria-haspopup="listbox" aria-expanded={open} title={title ?? "Модель"} onClick={() => setOpen(!open)}>{face}</button>}
      </Popover.Target>
      <Popover.Dropdown p={6}>
        <TextInput size="xs" autoFocus aria-label="Найти модель" leftSection={<IconSearch size={14} />} value={q} onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && first) (e.preventDefault(), pick(first)); }} />
        <div className="mp-list" role="listbox" aria-label="Модели">
          {pinned.map((o) => row(o, true))}
          {pinned.length > 0 && groups.length > 0 && <div className="mp-rule" role="separator" />}
          {groups.map(({ group, list }) => [<div key={"g" + group} className="mp-group">{group}</div>, ...list.map((o) => row(o, false))])}
          {!first && <div className="mp-none">Такой модели нет</div>}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
