// Вопрос из уведомления: нажатие на уведомление открывает приложение сразу с вопросом и крупными кнопками ответа поверх экрана.
// Нужен там, где у уведомлений нет кнопок (iPhone): ответ — одно касание после открытия, без поиска вопроса в ленте.
import { Modal, Stack, Text } from "@mantine/core";
import { useLocation, useNavigate } from "react-router";
import { useWide } from "../common.tsx";
import { AskCard } from "../session/Ask.tsx";
import { useFleet } from "../store/fleet.ts";

/** Какой вопрос показать поверх экрана: адрес называет сессию и номер вопроса, и вопрос в строке сессии — всё ещё он. */
export function askNowOf(pathname: string, search: string, sessions: Record<string, { ask?: { id: string } | null } | undefined>): { callsign: string; ask: string } | null {
  const ask = new URLSearchParams(search).get("ask");
  const callsign = decodeURIComponent(/^\/(?:inbox|work)\/([^/]+)/.exec(pathname)?.[1] ?? "");
  if (!ask || !callsign) return null;
  return sessions[callsign]?.ask?.id === ask ? { callsign, ask } : null;
}

export function AskNow() {
  const loc = useLocation(), go = useNavigate(), wide = useWide();
  const sessions = useFleet((f) => f.sessions);
  const now = askNowOf(loc.pathname, loc.search, sessions);
  if (!now) return null;
  const row = sessions[now.callsign]!;
  // закрыть — убрать вопрос из адреса: сессия остаётся открытой, вопрос виден в её ленте
  const close = () => go(loc.pathname, { replace: true });
  return (
    <Modal opened onClose={close} fullScreen={!wide} centered size="lg" title={<Text fw={600}>{row.title ?? now.callsign}</Text>} closeButtonProps={{ "aria-label": "Закрыть вопрос" }}>
      <Stack className="asknow" gap="md">
        <AskCard callsign={now.callsign} ask={row.ask!} sessionTitle={row.title} />
      </Stack>
    </Modal>
  );
}
