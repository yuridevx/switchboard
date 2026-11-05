// Телефон: оболочка сборки, узкий вид. «Вам» и «Работа» — своими разделами, остальное — вкладками «Флота».
import { boot } from "../../shell.ts";

void boot({ sections: ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"] });
