// Телефон: оболочка сборки. Модули, адрес relay и Worker'ов — из build.json сборки; своих адресов и секретов нет.
// Разделы: «Вам», «Работа» и «Флот» одной вкладкой (аккаунты, машины, инциденты, настройки).
import { boot } from "../../shell.ts";

void boot({ sections: ["inbox", "board", "accounts", "machines", "incidents", "settings"] });
