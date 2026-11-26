import { randomBytes } from "node:crypto";

export type IdPrefix = "th" | "msg" | "ch" | "rt" | "au" | "ar";

export function createId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}
