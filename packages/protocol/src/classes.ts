// Action classes and multipliers, spec §8.4.
export const ACTION_CLASSES = ["read", "search", "write", "account", "admin"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const CLASS_MULT: Record<ActionClass, number> = {
  read: 0,
  search: 1,
  write: 4,
  account: 8,
  admin: 16,
};

export function isActionClass(x: unknown): x is ActionClass {
  return typeof x === "string" && (ACTION_CLASSES as readonly string[]).includes(x);
}

/** True when a pass minted for `have` may authorize an action of class `need`. */
export function classCovers(have: ActionClass, need: ActionClass): boolean {
  return CLASS_MULT[have] >= CLASS_MULT[need];
}

/** Unmapped GET = read, unmapped POST (and other writes) = write. */
export function defaultClassForMethod(method: string): ActionClass {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}
