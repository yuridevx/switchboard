// Сборка телефона — общий скрипт веб-приложений.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../build.mjs";

await buildApp(dirname(fileURLToPath(import.meta.url)), "phone");
