/**
 * What every carrier implements.
 *
 * Two methods, and that is on purpose. "Buy a label" and "where is it" are
 * the operations a dispatch desk actually performs; pickup booking, manifests
 * and returns each have enough carrier-specific shape that folding them in
 * here would force the interface to grow a union type per carrier.
 */

import type { Capabilities, CarrierId, Label, Shipment, Tracking } from "./domain.ts";

export interface Carrier {
  readonly id: CarrierId;
  /** What this adapter can and cannot do. Read it rather than assuming. */
  readonly capabilities: Capabilities;
  createLabel(shipment: Shipment): Promise<Label>;
  track(trackingNumber: string): Promise<Tracking>;
}

/** Shared adapter configuration. */
export interface CarrierConfig {
  baseUrl: string;
  /** Injected, so every adapter is testable and the sandboxes slot in. */
  transport: import("./transport.ts").Transport;
  /** Overridable so label timestamps are assertable. */
  now?: () => Date;
}
