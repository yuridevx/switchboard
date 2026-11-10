// Удаление с подтверждением вводом имени: архив и инспектор сессии.
import { Button, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";

/** Удаление сессии архива — только после ввода её имени. */
export function DeleteTyped({ name, body, onDelete }: { name: string; body: string; onDelete: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <Stack gap="sm">
      <Text size="sm">{body}</Text>
      <TextInput label={<>Введите имя сессии: <span className="mono">{name}</span></>} className="mono" value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoFocus />
      <Button color="red" disabled={typed.trim() !== name} onClick={onDelete}>Удалить из архива</Button>
    </Stack>
  );
}
