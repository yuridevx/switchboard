import { renderInvoice } from "./modules/billing-ui/index.js";
import { createInvoice } from "./modules/billing-api/index.js";
const inv = createInvoice(10);
console.log(renderInvoice(inv.id));
