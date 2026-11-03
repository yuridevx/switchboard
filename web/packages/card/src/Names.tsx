// Окно «Имена» web-labels поверх карточки.
import { useApp } from "@switchboard/web-core";

export function Names({ callsign, close }: { callsign: string; close(): void }) {
  const app = useApp();
  return (
    <div>
      <app.Slot screen="labels" params={{ callsign }} close={close} />
    </div>
  );
}
