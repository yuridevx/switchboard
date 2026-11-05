// Место экрана: граница ошибки и область стилей вокруг компонента модуля. Новые параметры — экран начат заново.
import { Component, memo, type ReactNode } from "react";
import { AppCtx, BadCard, Cta, Pad, useApp } from "@switchboard/web-ui";
import { share } from "../share.ts";
import type { Params, Screen, SlotProps } from "../types.ts";
import { useCore } from "./context.ts";

class Boundary extends Component<{ onError(e: unknown): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Экран упавшего модуля: причина и перезапуск. */
function Failed({ def, why, restart }: { def: Screen; why: string; restart(): void }) {
  const name = def.label ?? "Экран";
  return (
    <Pad>
      <BadCard>
        <b>{`${name} выключен${name.endsWith("а") ? "а" : ""}`}</b>
        <code>{why}</code>
        <span>Остальные экраны работают. Этот вернётся после перезапуска приложения.</span>
      </BadCard>
      <Cta onClick={restart}>Перезапустить приложение</Cta>
    </Pad>
  );
}

const NO_PARAMS: Params = {};

function PlaceView({ screen, params = NO_PARAMS, close }: SlotProps) {
  const { snap, modules, win } = useCore();
  const entry = modules.screens.get(screen);
  const failed = snap.use(() => entry?.owner.failed ?? null);
  if (!entry) return null;
  if (failed) return <Failed def={entry.def} why={failed} restart={() => win.location.reload()} />;
  const View = entry.def.view;
  if (!View) return null;
  return (
    <div data-module={entry.owner.m.name} style={{ display: "contents" }}>
      <Boundary key={`${screen}?${JSON.stringify(params)}`} onError={(e) => modules.fail(entry.owner, `экране ${screen}`, e)}>
        <AppCtx.Provider value={entry.owner.app}>
          <View params={params} close={close} />
        </AppCtx.Provider>
      </Boundary>
    </div>
  );
}

/** Экран по имени, без проверки uses (её делают app.Slot и app.open). Родитель перерисовался с теми же параметрами — экран не трогается. */
export const Place = memo(PlaceView, (a, b) => a.screen === b.screen && a.close === b.close && share(a.params ?? NO_PARAMS, b.params ?? NO_PARAMS) === (a.params ?? NO_PARAMS));

/** app.Slot: чужой экран внутри экрана модуля. Экран вне uses — ошибка вызывающего: её ловит граница его экрана. */
export function Slot({ screen, params, close }: SlotProps) {
  const { modules } = useCore();
  const caller = modules.ofApp(useApp());
  if (!caller || !modules.mayOpen(caller, screen)) throw new Error(`экрана ${screen} нет в uses`);
  return <Place screen={screen} params={params} close={close} />;
}
