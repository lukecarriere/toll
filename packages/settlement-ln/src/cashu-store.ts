// Durable proofs the operator keeps, plus the spent-input set that rejects a replay after restart.
// The file holds secrets. It is mode 0600. Nothing in here is written to the log.
import { chmod, open, readFile, rename } from "node:fs/promises";

export interface StoredProof {
  mint: string;
  unit: "sat";
  amount: number;
  /** Full keyset id (66 hex chars for a version-01 id). */
  id: string;
  secret: string;
  C: string;
}

interface FileShape {
  v: 1;
  proofs: StoredProof[];
  spent: string[];
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
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, proofs: [], spent: [] };
    throw e;
  }
  const parsed = JSON.parse(text) as FileShape;
  if (parsed?.v !== 1 || !Array.isArray(parsed.proofs) || !Array.isArray(parsed.spent)) throw new Error("proof store");
  return parsed;
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

export class FileProofStore {
  private path: string;
  constructor(path: string) { this.path = path; }

  /** Run `fn` while holding the file. `seen` is true when any spent hash is already recorded. */
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
      if (dirty) await writeStore(this.path, { v: 1, proofs, spent: [...spent] });
      return result;
    });
  }

  async read(): Promise<FileShape> {
    return queue(this.path, () => readStore(this.path));
  }
}
