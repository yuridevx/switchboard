// Телефон: оболочка сборки. Модули, адрес relay и Worker'ов — из build.json сборки; своих адресов и секретов нет.
// Разделы: «Вам», «Работа», «Инциденты» и «Флот» одной вкладкой (аккаунты, машины, настройки).
import { boot } from "../../shell.ts";

void boot({ sections: ["inbox", "board", "incidents", "accounts", "machines", "settings"] });
