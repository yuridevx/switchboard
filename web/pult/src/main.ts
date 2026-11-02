// Пульт: оболочка сборки. Модули, адрес relay и Worker'ов — из build.json сборки; своих адресов и секретов нет.
import { boot } from "../../shell.ts";
import { PULT } from "./options.ts";

// GitHub вернул браузер с ?code= после создания приложения флота — его сохранят «Настройки», вкладка GitHub
if (new URLSearchParams(location.search).has("code") && !location.hash) history.replaceState(null, "", location.pathname + location.search + "#settings?tab=general");

void boot(PULT);
