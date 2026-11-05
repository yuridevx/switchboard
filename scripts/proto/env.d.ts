// Модули, которые сервер подставляет при сборке: приложение из web/<имя>/stand/parts.ts и мок папки дизайна.
declare module "@proto/app" {
  import type { AppPart, StartOptions } from "@switchboard/web-core";
  export const parts: () => AppPart[];
  export const options: Partial<StartOptions>;
  export const app: string;
}
declare module "@proto/mock" {
  const mock: import("./api.ts").ProtoMock;
  export default mock;
}
