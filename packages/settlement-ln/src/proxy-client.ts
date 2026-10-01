// Client for the L402 reverse-proxy settlement engine (docs/adapters.md §2). STUB ONLY in this build.
//
// Deployment shape (documented, not run here): the proxy sits in front of the issuer's paid routes,
// calls Toll's price endpoint over its dynamic-price gRPC hook, issues the 402 (invoice + macaroon)
// from its own node connection, verifies paid retries, and forwards them to Toll with the verified
// payment hash. Toll then mints its pass and books the payment.
//
// What exists now:
//   - `priceForPath`: the price-source logic the proxy will call (pure; Toll's prices, rounded up
//     to a whole base unit per settlement.md Q3).
//   - `ProxySettlementEngine` in mode "stub": delegates to the stub engine so the flow is testable
//     end to end with no node and no funds. Any other mode throws: there is no live path in this build.
import { StubEngine } from "./stub-engine.ts";
import type { Offer, Paid, PaidClass, PaidProof, SettlementEngine } from "./engine.ts";
import { priceMsat } from "./stub-engine.ts";

export interface ProxyEngineOptions {
  mode: "stub" | "live";
  /** Stub mode only. */
  secret?: string;
  stub?: StubEngine;
}

/** Price source for the proxy's dynamic-price hook: msat for the class, rounded UP to whole 1000 msat. */
export function priceForPath(o: { cls: PaidClass; velocity_mult?: number; suspicion_mult?: number }): { amount_msat: number; price_base_units: number } {
  const msat = priceMsat(o.cls, o.velocity_mult ?? 1, o.suspicion_mult ?? 1);
  const units = Math.ceil(msat / 1000);
  return { amount_msat: units * 1000, price_base_units: units };
}

export class ProxySettlementEngine implements SettlementEngine {
  readonly kind = "proxy" as const;
  private inner: StubEngine;

  constructor(o: ProxyEngineOptions) {
    if (o.mode !== "stub") throw new Error("settlement proxy: only stub mode exists in this build (no live funds, no node)");
    this.inner = o.stub ?? new StubEngine({ secret: o.secret ?? "" });
  }

  offer(o: { site: string; cls: PaidClass; amount_msat: number; now: number; ttl_s?: number }): Promise<Offer> {
    return this.inner.offer(o);
  }

  verifyPaid(o: { site: string; proof: PaidProof; now: number; firstUse: (key: string, ttl_s: number) => Promise<boolean> }): Promise<Paid> {
    return this.inner.verifyPaid(o);
  }

  healthy(): Promise<boolean> {
    return this.inner.healthy();
  }
}
