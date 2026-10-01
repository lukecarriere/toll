// Canonical JSON (spec §8.1): UTF-8, object keys sorted by code unit, no whitespace.
// Strings are escaped exactly like JSON.stringify (so "/" is not escaped and non-ASCII is raw UTF-8).
// Only integers are allowed as numbers so every implementation prints them identically.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical JSON allows safe integers only");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  throw new Error("canonical JSON: unsupported type " + typeof value);
}
