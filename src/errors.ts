/**
 * One error type, with a cause the caller can branch on.
 *
 * The three carriers signal failure in three incompatible ways and none of
 * them is "throw an HTTP status":
 *
 *   DHL returns 200 with a per-item `validationMessages` array, so a partially
 *   accepted consignment looks like a success.
 *   DPD returns 200 with a SOAP Fault in the body, and its most common fault
 *   message is generic enough to be actively misleading (see `dpd.ts`).
 *   GLS returns a real status code but puts the reason in a nested
 *   `exceptionText` the status does not describe.
 *
 * Mapping all three onto `kind` is what lets a caller write one retry policy
 * instead of three.
 */

import type { CarrierId } from "./domain.ts";

export type ErrorKind =
  /** Credentials rejected, or a token that needs refreshing. */
  | "auth"
  /** The shipment is wrong. Retrying unchanged will fail again. */
  | "validation"
  /** Slow down. */
  | "rate_limit"
  /** Their problem, not ours. Worth retrying. */
  | "carrier_down"
  /** We could not tell. Treated as not retryable, deliberately. */
  | "unknown";

/** Which kinds are worth trying again, and which would just fail identically. */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(["rate_limit", "carrier_down", "auth"]);

export class CarrierError extends Error {
  readonly carrier: CarrierId;
  readonly kind: ErrorKind;
  /** The carrier's own code or fault string, kept verbatim for support. */
  readonly carrierCode: string | undefined;
  /** Field-level detail where the carrier gives it. */
  readonly fields: readonly string[];

  constructor(
    carrier: CarrierId,
    kind: ErrorKind,
    message: string,
    options: { carrierCode?: string; fields?: readonly string[]; cause?: unknown } = {},
  ) {
    super(`[${carrier}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CarrierError";
    this.carrier = carrier;
    this.kind = kind;
    this.carrierCode = options.carrierCode;
    this.fields = options.fields ?? [];
  }

  /**
   * Whether retrying the same call could plausibly succeed.
   *
   * `auth` counts because the common cause is an expired token, and the
   * adapters re-authenticate on retry rather than asking the caller to.
   * `unknown` deliberately does not: retrying something we failed to
   * understand is how a duplicate label gets bought.
   */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}
