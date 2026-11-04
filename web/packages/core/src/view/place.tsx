// Место экрана: граница ошибки и область стилей вокруг компонента модуля. Новые параметры — экран начат заново.
import { Component, memo, type ReactNode } from "react";
import { BadCard, Cta, Pad, AppCtx, useApp } from "@switchboard/web-ui";
import { share } from "../same.ts";
import type { Params, Screen, SlotProps } from "../types.ts";
import { useCore } from "./core.ts";

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
function Failed({ def, why, reload }: { def: Screen; why: string; reload(): void }) {
  return (
    <Pad>
      <BadCard>
        <b>{`${def.label ?? "Экран"} выключен${def.label?.endsWith("а") ? "а" : ""}`}</b>
        <code>{why}</code>
        <span>Остальные экраны работают. Этот вернётся после перезапуска приложения.</span>
      </BadCard>
      <Cta onClick={reload}>Перезапустить приложение</Cta>
    </Pad>
  );
}

const NONE: Params = {};

function PlaceView({ screen, params, close }: SlotProps) {
  const core = useCore();
  const s = core.lookup(screen);
  const failed = core.use(() => s?.owner.failed ?? null);
  if (!s) return null;
  if (failed) return <Failed def={s.def} why={failed} reload={core.reload} />;
  const View = s.def.view;
  if (!View) return null;
  const p = params ?? NONE;
  return (
    <div data-module={s.owner.m.name} style={{ display: "contents" }}>
      <Boundary key={`${screen}?${JSON.stringify(p)}`} onError={(e) => core.fail(s.owner, `экране ${screen}`, e)}>
        <AppCtx.Provider value={s.owner.app}>
          <View params={p} close={close} />
        </AppCtx.Provider>
      </Boundary>
    </div>
  );
}

/** Экран по имени, без проверки uses (её делают app.Slot и app.open). Родитель перерисовался с теми же параметрами — экран не трогается. */
export const Place = memo(PlaceView, (a, b) => a.screen === b.screen && a.close === b.close && share(a.params ?? NONE, b.params ?? NONE) === (a.params ?? NONE));

/** app.Slot: чужой экран внутри экрана модуля. Экран вне uses — ошибка вызывающего: её ловит граница его экрана. */
export function Slot(p: SlotProps) {
  const core = useCore();
  if (!core.mayOpen(useApp(), p.screen)) throw new Error(`экрана ${p.screen} нет в uses`);
  return <Place screen={p.screen} params={p.params} close={p.close} />;
}
