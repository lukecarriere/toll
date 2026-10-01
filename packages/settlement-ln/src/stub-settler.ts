// Stub settler for tests and CI (spec §8.6.7). It never talks to any network.
// Invoices are fake strings ("lnstub1…"); payment_hash = SHA256(preimage) like the real thing.
import { concat, randomBytes, sha256, toHex, fromHex, utf8 } from "../../protocol/src/index.ts";

export interface Invoice {
  invoice: string;
  payment_hash: string; // hex
  amount_msat: number;
  expires_at: number;
}

export interface Settler {
  readonly kind: "stub" | "regtest" | "nwc" | "lnd_rest";
  mintInvoice(o: { amount_msat: number; memo: string; expiry_s: number; now: number }): Promise<Invoice>;
  /** Health for the degraded-mode switch (spec §8.6.8). */
  healthy(): Promise<boolean>;
}

export class StubSettler implements Settler {
  readonly kind = "stub" as const;
  private preimages = new Map<string, string>();
  private down = false;
  private shared?: string;

  /** `sharedPreimage`: every invoice uses this test preimage (spec: "fake settler that accepts a shared test preimage"). */
  constructor(o: { sharedPreimage?: string } = {}) {
    this.shared = o.sharedPreimage;
  }

  setDown(down: boolean) {
    this.down = down;
  }

  async healthy() {
    return !this.down;
  }

  async mintInvoice(o: { amount_msat: number; memo: string; expiry_s: number; now: number }): Promise<Invoice> {
    if (this.down) throw new Error("settler unavailable");
    if (!Number.isSafeInteger(o.amount_msat) || o.amount_msat <= 0) throw new Error("bad amount");
    const preimage = this.shared ?? toHex(randomBytes(32));
    const payment_hash = toHex(await sha256(fromHex(preimage)));
    // Unique per invoice even with a shared preimage: the memo nonce is part of the fake string.
    const nonce = toHex(await sha256(concat(utf8(o.memo), randomBytes(8)))).slice(0, 16);
    const invoice = `lnstub1${o.amount_msat}m1${payment_hash}${nonce}`;
    this.preimages.set(payment_hash, preimage);
    return { invoice, payment_hash, amount_msat: o.amount_msat, expires_at: o.now + o.expiry_s };
  }

  /** Test wallet: "pay" a stub invoice and get its preimage. */
  pay(invoice: string): string {
    const m = /^lnstub1\d+m1([0-9a-f]{64})/.exec(invoice);
    const pre = m && this.preimages.get(m[1]);
    if (!pre) throw new Error("unknown stub invoice");
    return pre;
  }
}
