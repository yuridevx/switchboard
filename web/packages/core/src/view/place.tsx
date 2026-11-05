// Место экрана: своя граница ошибки, своё useApp, область стилей модуля.
import { Component, createContext, memo, useContext, type ReactNode } from "react";
import { AppCtx, BadCard, Cta, Pad } from "@switchboard/web-ui";
import type { Core } from "../app.ts";
import type { Mod } from "../modules.ts";
import type { Pass } from "../pass.ts";
import type { Params } from "../types.ts";

export const CoreCtx = createContext<Core & { pass: Pass }>(null as never);
export const useCore = () => useContext(CoreCtx);

/** Ошибка отрисовки уходит владельцу; своё место пустеет. */
export class Boundary extends Component<{ onError(e: unknown): void; children: ReactNode }, { broken: boolean }> {
  override state = { broken: false };
  static getDerivedStateFromError = () => ({ broken: true });
  override componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  override render() {
    return this.state.broken ? null : this.props.children;
  }
}

/** Подпись выключенного экрана: род по окончанию. */
const offLabel = (label = "Экран") => `${label} выключен${label.endsWith("а") ? "а" : ""}`;

type PlaceProps = { screen: string; params?: Params; close?: () => void };

const same = (a: PlaceProps, b: PlaceProps) => a.screen === b.screen && a.close === b.close && JSON.stringify(a.params) === JSON.stringify(b.params);

export const Place = memo(function Place({ screen, params = {}, close }: PlaceProps) {
  const { page, mods } = useCore();
  const { mod, def } = mods.screens.get(screen)!;
  const why = page.use(() => page.failed[mod.name]);
  if (why !== undefined) {
    return (
      <Pad>
        <BadCard>
          <b>{offLabel(def.label)}</b>
          <code>{why}</code>
          <span>Остальные экраны работают. Этот вернётся после перезапуска приложения.</span>
        </BadCard>
        <Cta onClick={() => page.win.location.reload()}>Перезапустить приложение</Cta>
      </Pad>
    );
  }
  const View = def.view!;
  return (
    <Boundary onError={(e) => mods.crash(mod, `экране ${screen}`, e)}>
      <div data-module={mod.name} style={{ display: "contents" }}>
        <AppCtx.Provider value={mod.app}>
          <View params={params} close={close} />
        </AppCtx.Provider>
      </div>
    </Boundary>
  );
}, same);

/** app.Slot: чужой экран в своём; нет права — ошибка вызывающего, её ловит его граница. */
export function Slot({ from, ...place }: PlaceProps & { from: Mod }) {
  const { mods } = useCore();
  const item = mods.screens.get(place.screen);
  if (!mods.reaches(from, item, place.screen)) throw new Error(`экрана ${place.screen} нет в uses`);
  return item ? <Place key={place.screen + JSON.stringify(place.params)} {...place} /> : null;
}
