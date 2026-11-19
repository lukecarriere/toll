// Runtime price checks: a TypeScript offer type does not validate remote JSON.
import { CASHU_UNIT, decodePaymentRequest } from "../../settlement-ln/src/cashu.ts";
import type { AgentOffer } from "./index.ts";

export function hasBoundPrice(offer: AgentOffer): boolean {
  if (!offer || !Number.isSafeInteger(offer.amount_msat) || offer.amount_msat <= 0) return false;
  if (offer.kind === "ln402") return true; // The caller's ln402 payer checks its own invoice.
  if (offer.kind !== "cashu" || offer.unit !== CASHU_UNIT ||
      !Number.isSafeInteger(offer.amount) || offer.amount <= 0 ||
      !Number.isSafeInteger(offer.amount * 1000) || offer.amount_msat !== offer.amount * 1000) return false;
  try {
    const request = decodePaymentRequest(offer.request);
    return request.u === CASHU_UNIT && request.a === offer.amount;
  } catch {
    return false;
  }
}
