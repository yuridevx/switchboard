// «Пока вас не было»: пуши, пришедшие без открытой страницы, — списком при открытии; нажатие ведёт туда же, куда вело уведомление.
import { Button, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { isMock } from "../api.ts";
import { missedOf, takeMissed, type Missed } from "../lib/push.ts";
import { hhmm } from "../lib/time.ts";

export function MissedList({ list, go }: { list: Missed[]; go: (hash: string) => void }) {
  const { shown, rest } = missedOf(list);
  return (
    <Stack gap={6}>
      {shown.map((m) => (
        <button key={m.at + m.hash} type="button" className="missed" onClick={() => go(m.hash)}>
          <Text size="sm" fw={600} className="trunc">{m.title}</Text>
          <Text size="xs" className="clamp2">{hhmm(m.at)}{m.text ? ` · ${m.text}` : ""}</Text>
        </button>
      ))}
      {rest > 0 && <Text size="xs">и ещё {rest} — в «Вам»</Text>}
    </Stack>
  );
}

/** Показывает сохранённые пуши один раз при открытии страницы. */
export function Missed() {
  const go = useNavigate();
  useEffect(() => {
    if (isMock) return;
    void takeMissed().then((list) => {
      if (!list.length) return;
      const id = "missed";
      notifications.show({
        id, title: "Пока вас не было", autoClose: false,
        message: <><MissedList list={list} go={(hash) => (notifications.hide(id), go(hash))} /><Button size="compact-xs" variant="subtle" mt={6} onClick={() => notifications.hide(id)}>Скрыть</Button></>,
      });
    });
  }, []);
  return null;
}
