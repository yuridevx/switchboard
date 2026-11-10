// Приглашение: ссылка, QR для телефона и само приглашение кодом (для программы).
import { Button, CopyButton, Group, Stack, Text } from "@mantine/core";
import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** Ссылка-приглашение на эту страницу. */
export const linkOf = (inv: string, at: { origin: string; pathname: string; search: string } = location) => `${at.origin}${at.pathname === "/consent" ? "/" : at.pathname}${at.search}#invite=${encodeURIComponent(inv)}`;

/** QR ссылки — SVG строкой. */
export function qrSvg(text: string, cell = 4): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 0, scalable: false });
}

export function InviteLink({ invite, program }: { invite: string; program?: boolean }) {
  const link = linkOf(invite);
  const svg = useMemo(() => qrSvg(link), [link]);
  return (
    <Stack gap="xs">
      <Text size="sm">Действует сутки и принимается один раз.</Text>
      {program ? (
        <>
          <pre className="codebox">{invite}</pre>
          <CopyButton value={invite}>{({ copied, copy }) => <Button size="xs" variant="default" w="fit-content" onClick={copy}>{copied ? "Скопировано" : "Скопировать приглашение"}</Button>}</CopyButton>
        </>
      ) : (
        <>
          <Group align="start" gap="md" wrap="wrap">
            <div className="qr" role="img" aria-label="QR ссылки-приглашения" dangerouslySetInnerHTML={{ __html: svg }} />
            <Stack gap="xs" style={{ flex: "1 1 200px", minWidth: 0 }}>
              <pre className="codebox">{link}</pre>
              <Group gap="xs">
                <CopyButton value={link}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? "Скопировано" : "Скопировать ссылку"}</Button>}</CopyButton>
                <CopyButton value={invite}>{({ copied, copy }) => <Button size="xs" variant="subtle" onClick={copy}>{copied ? "Скопировано" : "Только приглашение"}</Button>}</CopyButton>
              </Group>
            </Stack>
          </Group>
        </>
      )}
    </Stack>
  );
}
