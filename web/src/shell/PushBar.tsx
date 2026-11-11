// Полоса «Включить уведомления»: видна, пока на устройстве их можно включить и человек её не скрыл. Состояние проверяется при открытии.
import { Button, CloseButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, isMock, sayError } from "../api.ts";
import { useLocal } from "../lib/local.ts";
import { enablePush, pushState, type PushState } from "../lib/push.ts";

export const PUSH_WORD: Record<PushState, string> = {
  on: "Уведомления включены на этом устройстве",
  off: "Уведомления на этом устройстве выключены",
  denied: "Браузер запретил уведомления: разрешите их в настройках сайта",
  unsupported: "Этот браузер не умеет уведомления",
  install: "На iPhone уведомления работают из приложения на экране «Домой»",
};

/** Включить уведомления и сказать итог. Общая кнопка полосы и настроек. */
export async function turnOnPush(): Promise<PushState> {
  try {
    const s = await enablePush(api);
    notifications.show({ message: PUSH_WORD[s], color: s === "on" ? "teal" : "orange" });
    return s;
  } catch (e) {
    notifications.show({ title: "Уведомления не включились", message: sayError(e), color: "red", autoClose: 7000 });
    return "off";
  }
}

export function PushBar() {
  const qc = useQueryClient();
  const [state, setState] = useState<PushState | null>(null);
  const [hidden, setHidden] = useLocal("pushBarHidden", false);
  useEffect(() => {
    if (!isMock) void pushState().then(setState);
  }, []);
  if (state !== "off" || hidden) return null;
  return (
    <div className="banner" role="status" style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ flex: 1, minWidth: 0 }}>{PUSH_WORD.off}</span>
      <Button size="compact-xs" onClick={async () => { setState(await turnOnPush()); void qc.invalidateQueries({ queryKey: ["reach.devices"] }); }}>Включить</Button>
      <CloseButton size="sm" aria-label="Скрыть" onClick={() => setHidden(true)} />
    </div>
  );
}
