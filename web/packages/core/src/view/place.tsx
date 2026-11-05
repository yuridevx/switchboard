// Место экрана: граница ошибки, чей он, область стилей. Модуль выключен — причина вместо экрана.
import { Component, createElement, memo, useMemo, type CSSProperties, type ReactNode } from "react";
import { AppCtx, Cta, Pad, BadCard } from "@switchboard/web-ui";
import type { Entry, Modules } from "../modules.ts";
import { sameParams } from "../route.ts";
import type { Params, Screen, SlotProps } from "../types.ts";

const CONTENTS: CSSProperties = { display: "contents" };

/** Граница ошибки: ловит отрисовку и сообщает; дальше место показывает причину. */
class Catch extends Component<{ on(error: Error): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError = () => ({ failed: true });
  componentDidCatch(error: Error) {
    this.props.on(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Экран упавшего модуля. */
function Off({ label, why, reload }: { label?: string; why: string; reload(): void }) {
  const name = label ?? "Экран";
  return (
    <Pad>
      <BadCard>
        <b>{`${name} выключен${name.endsWith("а") ? "а" : ""}`}</b>
        <code>{why}</code>
        <span>Остальные экраны работают. Этот вернётся после перезапуска приложения.</span>
      </BadCard>
      <Cta onClick={reload}>Перезапустить приложение</Cta>
    </Pad>
  );
}

type PlaceProps = { entry: Entry; name: string; screen: Screen; params: Params; close?: () => void; modules: Modules };

export function Place({ entry, name, screen, params, close, modules }: PlaceProps) {
  const why = modules.bus.use(() => modules.core.failed[entry.name]);
  if (why) return <Off label={screen.label} why={why} reload={modules.reload} />;
  const View = screen.view!;
  return (
    <Catch key={`${name}?${JSON.stringify(params)}`} on={(e) => modules.fail(entry, `экране ${name}`, e)}>
      <AppCtx.Provider value={entry.app}>
        <div data-module={entry.name} style={CONTENTS}>
          <View params={params} close={close} />
        </div>
      </AppCtx.Provider>
    </Catch>
  );
}

const NO_PARAMS: Params = {};

/** app.Slot модуля: чужой экран в своём. Равные параметры в новом объекте — тот же экран без перерисовки. */
export const slotFor = (e: Entry, modules: Modules) =>
  memo(
    function Slot({ screen, params = NO_PARAMS, close }: SlotProps) {
      const same = useMemo(() => params, [JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps
      const found = modules.screenFor(e, screen);
      if (!found) {
        modules.fail(e, `экране ${screen}`, new Error(`экрана ${screen} нет в uses`));
        return null;
      }
      return createElement(Place, { entry: found[0], name: screen, screen: found[1], params: same, close, modules });
    },
    (a, b) => a.screen === b.screen && a.close === b.close && sameParams(a.params, b.params),
  );
