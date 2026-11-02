// SHA-256 архива выпуска, hex.
import { createHash } from "node:crypto";

export const sha256hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
