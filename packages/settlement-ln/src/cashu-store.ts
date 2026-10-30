// Durable proofs the operator keeps, plus the spent-input set that rejects a replay after restart.
// The file holds secrets. It is mode 0600. Nothing in here is written to the log.
// CashuReceiveEngine talks to the ProofStore interface. FileProofStore is the Node implementation.
import { chmod, open, readFile, rename } from "node:fs/promises";
import { TollError } from "../../protocol/src/errors.ts";

export interface StoredProof {
  mint: string;
  unit: "sat";
  amount: number;
  /** Full keyset id (66 hex chars for a version-01 id). */
  id: string;
  secret: string;
  C: string;
}

/** One blinded output saved before POST /v1/swap. `r` is the blinding factor, 32 bytes hex. */
export interface PendingOutput {
  amount: number;
  id: string;
  secret: string;
  r: string;
  B_: string;
}

/**
 * A swap whose outputs are durable and whose mint call may not have finished.
 * `inSats` is the sum of the inputs. `outSats` is the sum of the blinded outputs (inputs minus fees).
 */
export interface PendingSwap {
  id: string;
  /** Unix ms when the row was saved. Absent on rows written before this field; those are treated as old. */
  at?: number;
  mint: string;
  unit: "sat";
  inSats: number;
  outSats: number;
  marks: string[];
  inputs: { amount: number; id: string; secret: string; C: string }[];
  outputs: PendingOutput[];
}

export interface CashuBooks {
  /** stored + pending + losses. Custody the store has accepted and not given back. */
  inSats: number;
  stored: number;
  pending: number;
  losses: number;
  /** How many input secrets are marked spent. */
  spent: number;
}

export interface ProofSnapshot {
  proofs: StoredProof[];
  spent: string[];
  pending: PendingSwap[];
  losses: number;
}

/**
 * Proofs, spent inputs, and in-flight swaps. `begin` returns only after the pending swap is durable.
 * `commit` returns only after the new proofs and the spent marks are durable.
 */
export interface ProofStore {
  read(): Promise<ProofSnapshot>;
  books(): Promise<CashuBooks>;
  begin(p: PendingSwap): Promise<PendingSwap>;
  commit(o: { id: string; proofs: StoredProof[]; marks: string[] }): Promise<void>;
  /** The mint never took the inputs. Drops the pending swap and its fee. */
  abort(id: string): Promise<void>;
  /** Inputs are spent and the outputs cannot be restored. Counts `outSats` as a loss and marks the inputs spent. */
  lose(o: { id: string; marks: string[] }): Promise<void>;
}

interface FileShape {
  v: 1;
  proofs: StoredProof[];
  spent: string[];
  pending: PendingSwap[];
  losses: number;
}

const locks = new Map<string, Promise<unknown>>();

function queue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(path, run.then(() => undefined, () => undefined));
  return run;
}

async function readStore(path: string): Promise<FileShape> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, proofs: [], spent: [], pending: [], losses: 0 };
    throw e;
  }
  const parsed = JSON.parse(text) as FileShape;
  if (parsed?.v !== 1 || !Array.isArray(parsed.proofs) || !Array.isArray(parsed.spent)) throw new Error("proof store");
  return {
    v: 1,
    proofs: parsed.proofs,
    spent: parsed.spent,
    pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    losses: Number.isSafeInteger(parsed.losses) && parsed.losses >= 0 ? parsed.losses : 0,
  };
}

async function writeStore(path: string, data: FileShape): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(JSON.stringify(data));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function booksOf(file: FileShape): CashuBooks {
  const stored = file.proofs.reduce((n, p) => n + p.amount, 0);
  const pending = file.pending.reduce((n, p) => n + p.outSats, 0);
  const losses = file.losses;
  return { stored, pending, losses, spent: file.spent.length, inSats: stored + pending + losses };
}

export class FileProofStore implements ProofStore {
  private path: string;
  constructor(path: string) { this.path = path; }

  /**
   * Run `fn` while holding the file. The in-process queue and the 0600 replace are unchanged.
   * Pending swaps written by begin/commit are kept across this rewrite.
   */
  async transaction<T>(fn: (s: { proofs: StoredProof[]; spent: Set<string>; addProofs: (p: StoredProof[]) => void; addSpent: (hashes: string[]) => void }) => Promise<T>): Promise<T> {
    return queue(this.path, async () => {
      const file = await readStore(this.path);
      const spent = new Set(file.spent);
      const proofs = file.proofs.slice();
      let dirty = false;
      const result = await fn({
        proofs,
        spent,
        addProofs: (p) => { proofs.push(...p); dirty = true; },
        addSpent: (hashes) => { for (const h of hashes) spent.add(h); dirty = true; },
      });
      if (dirty) await writeStore(this.path, { v: 1, proofs, spent: [...spent], pending: file.pending, losses: file.losses });
      return result;
    });
  }

  async read(): Promise<ProofSnapshot> {
    const file = await queue(this.path, () => readStore(this.path));
    return { proofs: file.proofs, spent: file.spent, pending: file.pending, losses: file.losses };
  }

  async books(): Promise<CashuBooks> {
    return booksOf(await queue(this.path, () => readStore(this.path)));
  }

  async begin(p: PendingSwap): Promise<PendingSwap> {
    return queue(this.path, async () => {
      const file = await readStore(this.path);
      if (p.marks.some((h) => file.spent.includes(h))) throw new TollError("replay");
      const existing = file.pending.find((x) => x.marks.some((h) => p.marks.includes(h)));
      if (existing) return existing;
      file.pending.push(p);
      file.losses += p.inSats - p.outSats;
      await writeStore(this.path, file);
      return p;
    });
  }

  async commit(o: { id: string; proofs: StoredProof[]; marks: string[] }): Promise<void> {
    return queue(this.path, async () => {
      const file = await readStore(this.path);
      const pending = file.pending.find((x) => x.id === o.id);
      if (!pending) {
        if (o.marks.length > 0 && o.marks.every((h) => file.spent.includes(h))) return;
        throw new TollError("store_unavailable");
      }
      const got = o.proofs.reduce((n, p) => n + p.amount, 0);
      if (got !== pending.outSats) throw new TollError("store_unavailable");
      file.proofs.push(...o.proofs);
      for (const h of o.marks) if (!file.spent.includes(h)) file.spent.push(h);
      file.pending = file.pending.filter((x) => x.id !== o.id);
      await writeStore(this.path, file);
    });
  }

  async abort(id: string): Promise<void> {
    return queue(this.path, async () => {
      const file = await readStore(this.path);
      const pending = file.pending.find((x) => x.id === id);
      if (!pending) return;
      file.losses -= pending.inSats - pending.outSats;
      if (file.losses < 0) file.losses = 0;
      file.pending = file.pending.filter((x) => x.id !== id);
      await writeStore(this.path, file);
    });
  }

  async lose(o: { id: string; marks: string[] }): Promise<void> {
    return queue(this.path, async () => {
      const file = await readStore(this.path);
      const pending = file.pending.find((x) => x.id === o.id);
      if (!pending) return;
      file.losses += pending.outSats;
      file.pending = file.pending.filter((x) => x.id !== o.id);
      for (const h of o.marks) if (!file.spent.includes(h)) file.spent.push(h);
      await writeStore(this.path, file);
    });
  }
}
