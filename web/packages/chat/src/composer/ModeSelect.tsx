// Режим разрешений сессии: выбор в ряду под полем ввода — на широком и узком экране. Значение — поле roster: его меняет Host, а не выбор.
import { useEffect } from "react";
import { PERM_MODES } from "@switchboard/web-ui";
import { useChat, useConv } from "../context.ts";
import type { Model } from "../state/chat.ts";

const AUTO = "auto";

/** Модель сессии в списке SDK: точное имя или короткое внутри полного; нет такой — та, что по умолчанию. */
function modelOf(models: Model[], model: string | undefined): Model | undefined {
  return models.find((m) => m.value === model) ?? models.find((m) => model?.includes(m.value)) ?? models.find((m) => m.value === "default");
}

export function ModeSelect({ callsign, mode }: { callsign: string; mode: string }) {
  const chat = useChat();
  const model = useConv(callsign, (c) => c.feed.model);
  const models = useConv(callsign, (c) => c.models);
  useEffect(() => void chat.loadModels(callsign), [chat, callsign]);
  const auto = !!modelOf(models ?? [], model)?.supportsAutoMode;
  const known = PERM_MODES.some(([v]) => v === mode);
  return (
    <select className="chat-mode" aria-label="Режим разрешений" title="Режим разрешений" data-mode={mode} value={mode} onChange={(e) => void chat.call(callsign, "setPermissionMode", [e.currentTarget.value])}>
      {PERM_MODES.filter(([v]) => v !== AUTO || auto || mode === AUTO).map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
      {known ? null : <option value={mode}>{mode}</option>}
    </select>
  );
}
