// Место экрана: граница ошибки и область стилей вокруг компонента модуля. Новые параметры — экран начат заново.
import { Component, memo, type ComponentType, type ReactNode } from "react";
import { BadCard, Cta, Pad } from "@switchboard/web-ui";
import type { Mod } from "../app.tsx";
import { same } from "../same.ts";
import type { Params, Screen, SlotProps } from "../types.ts";

type Deps = {
  lookup(screen: string): { owner: Mod; def: Screen } | undefined;
  use<T>(select: () => T): T;
  fail(x: Mod, where: string, e: unknown): void;
  reload(): void;
};

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

/** Компонент места для ядра: экран по имени, без проверки uses (её делают app.Slot и app.open). Родитель перерисовался — экран нет. */
export function place({ lookup, use, fail, reload }: Deps): ComponentType<SlotProps> {
  function Place({ screen, params, close }: SlotProps) {
    const s = lookup(screen);
    const failed = use(() => s?.owner.failed ?? null);
    if (!s) return null;
    if (failed) return <Failed def={s.def} why={failed} reload={reload} />;
    const View = s.def.view;
    if (!View) return null;
    const p = params ?? NONE;
    return (
      <div data-module={s.owner.m.name} style={{ display: "contents" }}>
        <Boundary key={JSON.stringify(p)} onError={(e) => fail(s.owner, `экране ${screen}`, e)}>
          <View params={p} close={close} />
        </Boundary>
      </div>
    );
  }
  return memo(Place, (a, b) => a.screen === b.screen && a.close === b.close && same(a.params ?? NONE, b.params ?? NONE)) as unknown as ComponentType<SlotProps>;
}
