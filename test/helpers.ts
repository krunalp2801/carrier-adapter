/**
 * Shared test fixtures: a known-good shipment and a transport that replies
 * with whatever a test hands it.
 */

import type { Address, Shipment } from "../src/domain.ts";
import type { Transport, TransportRequest, TransportResponse } from "../src/transport.ts";

export const SHIPPER: Address = {
  name: "Gift Bundle Supplies",
  street: "Hanauer Landstrasse",
  houseNumber: "126",
  postcode: "60314",
  city: "Frankfurt am Main",
  countryCode: "DE",
};

export const RECIPIENT: Address = {
  name: "Thomas Bauer",
  street: "Lindenallee",
  houseNumber: "7",
  postcode: "50667",
  city: "Koeln",
  countryCode: "DE",
  phone: "+49 221 998877",
  email: "t.bauer@example.de",
};

export function shipment(patch: Partial<Shipment> = {}): Shipment {
  return {
    reference: "SO-10042",
    shipper: SHIPPER,
    recipient: RECIPIENT,
    parcels: [{ weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15, reference: "SO-10042-1" }],
    serviceLevel: "standard",
    ...patch,
  };
}

/** A transport that replies from a script and records what it was sent. */
export function scriptedTransport(
  replies: Array<TransportResponse | ((request: TransportRequest) => TransportResponse)>,
): Transport & { readonly sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  let index = 0;
  return {
    sent,
    async send(request: TransportRequest): Promise<TransportResponse> {
      sent.push(request);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error("scriptedTransport ran out of replies");
      return typeof reply === "function" ? reply(request) : reply;
    },
  };
}

export const jsonReply = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const xmlReply = (body: string): TransportResponse => ({
  status: 200,
  headers: { "content-type": "text/xml" },
  body,
});

export const FIXED_NOW = (): Date => new Date("2026-09-29T08:00:00.000Z");
