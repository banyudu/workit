import { readFileSync } from "node:fs";

export const CACHE_NAMES = new Set(["node_modules", ".build", ".next", "target"]);
export function readJSON<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
