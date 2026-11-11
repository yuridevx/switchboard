// Соединение страницы с картиной флота: состояние, причина остановки, когда следующая попытка, «подключиться сейчас».
import type { Link, LinkState } from "@sb/protocol";
import { create } from "zustand";
import { api } from "../api.ts";
import { useFleet } from "../store/fleet.ts";

type LinkMeta = {
  state: LinkState;
  /** слово закрытия у stopped: revoked, bad_key, proto, forbidden… */
  why?: string;
  /** когда пришёл последний кадр картины */
  seen: number;
  /** когда следующая попытка подключиться */
  retryAt?: number;
};
export const useLink = create<LinkMeta>(() => ({ state: "connecting", seen: 0 }));

let link: Link | null = null;

/** Открыть соединение заново: при входе и по кнопке «Сейчас». */
export function openPage(): void {
  link?.close();
  useLink.setState({ state: "connecting", why: undefined, retryAt: undefined });
  useFleet.getState().setLink("connecting");
  link = api.transport.open("page", {
    onFrame: (f) => {
      useFleet.getState().apply(f);
      useLink.setState({ seen: Date.now() });
    },
    onState: (state, why) => {
      useFleet.getState().setLink(state);
      useLink.setState({ state, why, ...(state === "open" ? { retryAt: undefined } : {}) });
    },
    onPause: (ms) => useLink.setState({ retryAt: Date.now() + ms }),
  });
}

export function closePage(): void {
  link?.close();
  link = null;
}

/** Слово о связи для лампы и полосы. */
export const linkWord = (s: LinkState): string => (s === "open" ? "на связи" : s === "connecting" ? "подключаюсь" : s === "stopped" ? "связь остановлена" : "нет связи");
