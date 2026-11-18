// Types for the plain JS live checks, so tests import them without a suppression.
export function redact(value: unknown): string;
export const EXPECT_MODES: string[];
export function l402Challenge(header: string | null): { scheme: string | null; amount_msat: number | null; macaroon?: boolean };
export function freeChecks(o: {
  base: string;
  expect: string;
  l402?: boolean;
  note: (check: string, status: string, detail?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
}): Promise<void>;
