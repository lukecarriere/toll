// Expected to FAIL on 266c9a0d28e5583fa8fb8c917e6e4a793e82aa9a.
// Not part of the root test run. Two payments that share an input both receive a pass
// from the one swap the store kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CashuReceiveEngine, decodeToken, encodeTokenV4, startKeysetMint } from "../../packages/settlement-ln/src/index.ts";
import { FileProofStore } from "../../packages/settlement-ln/src/cashu-store.ts";

test("overlapping inputs grant one pass", async () => {
  const mint = await startKeysetMint();
  const dir = mkdtempSync(join(tmpdir(), "loupe-overlap-"));
  const store = new FileProofStore(join(dir, "proofs.json"));
  const engine = new CashuReceiveEngine({
    secret: "cashu-receive-test-secret",
    mints: [mint.url],
    store,
    loopbackHttp: true,
  });
  const now = 1_790_000_000;
  try {
    const search = await engine.offer({ site: "s", cls: "search", amount_msat: 2000, now });
    const write = await engine.offer({ site: "s", cls: "write", amount_msat: 8000, now });
    const eight = decodeToken(mint.token(8));
    const one = decodeToken(mint.token(1));
    const shared = encodeTokenV4({ mint: mint.url, unit: "sat", proofs: eight.proofs });
    const both = encodeTokenV4({ mint: mint.url, unit: "sat", proofs: [...eight.proofs, ...one.proofs] });
    const seen = new Set<string>();
    const firstUse = async (key: string) => (seen.has(key) ? false : (seen.add(key), true));
    const pay = (offer: { id: string; credential: string }, token: string) => engine.verifyPaid({
      site: "s",
      now: now + 1,
      firstUse,
      proof: { kind: "cashu", offer_id: offer.id, credential: offer.credential, token },
    });
    const results = await Promise.allSettled([pay(search, shared), pay(write, both)]);
    const granted = results.filter((r) => r.status === "fulfilled").length;
    const books = await store.books();
    assert.equal(
      granted,
      1,
      `granted=${granted} swaps=${mint.swaps()} signed=${mint.signedSats()} stored=${books.stored} spent=${books.spent}`,
    );
  } finally {
    await mint.close();
  }
});
