export type TollErrorCode =
  | "malformed"
  | "unsupported"
  | "bad_sig"
  | "expired"
  | "not_yet_valid"
  | "wrong_site"
  | "wrong_action"
  | "replay"
  | "bad_solution"
  | "class_too_low"
  | "exhausted"
  | "store_unavailable"
  | "rate_limited";

export class TollError extends Error {
  code: TollErrorCode;
  constructor(code: TollErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "TollError";
  }
}
