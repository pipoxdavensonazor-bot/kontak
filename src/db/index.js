import { drizzle } from "drizzle-orm/d1";
import { eq, and, or, like, desc, lt } from "drizzle-orm";
import * as schema from "./schema.js";

export function getDb(d1) {
  return drizzle(d1, { schema });
}

export { schema, eq, and, or, like, desc, lt };
