// Режим разрешений сессии: выбор в ряду под полем ввода — на широком и узком экране. Значение — из ленты: его меняет кадр status, а не выбор.
import { useLoad } from "@switchboard/web-ui";
import { useChat } from "../context.ts";

type Model = { value: string; supportsAutoMode?: boolean };

const MODES: Array<[string, string]> = [
  ["bypassPermissions", "Без вопросов"],
  ["default", "Спрашивать"],
  ["acceptEdits", "Правки сами"],
  ["plan", "План"],
];
const AUTO = "auto";

/** Модель сессии в списке SDK: точное имя или короткое внутри полного; нет такой — та, что по умолчанию. */
function modelOf(models: Model[], model: string | undefined): Model | undefined {
  return models.find((m) => m.value === model) ?? models.find((m) => model?.includes(m.value)) ?? models.find((m) => m.value === "default");
}

export function ModeSelect({ callsign, mode }: { callsign: string; mode: string }) {
  const chat = useChat();
  const model = chat.useConv(callsign, (c) => c.feed.model);
  const { data } = useLoad<Model[] | null>(() => chat.ask<Model[] | null>(callsign, "supportedModels"), [chat, callsign]);
  const auto = !!modelOf(Array.isArray(data) ? data : [], model)?.supportsAutoMode;
  const known = mode === AUTO || MODES.some(([v]) => v === mode);
  return (
    <select className="chat-mode" aria-label="Режим разрешений" title="Режим разрешений" data-mode={mode} value={mode} onChange={(e) => void chat.call(callsign, "setPermissionMode", [e.currentTarget.value])}>
      {MODES.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
      {auto || mode === AUTO ? <option value={AUTO}>Авто</option> : null}
      {known ? null : <option value={mode}>{mode}</option>}
    </select>
  );
}
