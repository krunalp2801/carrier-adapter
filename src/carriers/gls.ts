/**
 * GLS ShipIT, as JSON REST with basic auth.
 *
 * This one is the best behaved of the three: real HTTP status codes, and a
 * validator strict enough to be useful. Strict enough, in fact, that it is
 * the reason `address.ts` reformats postcodes rather than merely checking
 * them: ShipIT rejects a UK postcode without its space, and a rejection at
 * label time means an order that is already picked.
 *
 * Its one quirk worth modelling: the reason for a failure is in a nested
 * `exceptionText` that the status code does not describe, so a caller that
 * only reads the status gets "400" and no idea which field.
 */

import { CarrierError } from "../errors.ts";
import type { Capabilities, Label, ParcelLabel, Shipment, Tracking, TrackingEvent, TrackingStatus } from "../domain.ts";
import type { Carrier, CarrierConfig } from "../carrier.ts";

export interface GlsConfig extends CarrierConfig {
  username: string;
  password: string;
  contactId: string;
}

export const GLS_CAPABILITIES: Capabilities = {
  // ShipIT returns the label and the tracking ids, not a price.
  reportsCost: false,
  multiParcel: true,
  labelFormats: ["pdf", "zpl"],
  serviceLevels: ["standard", "express"],
  tracking: true,
  // ShipIT keys on the shipment reference: re-posting the same one returns
  // the original consignment instead of buying a second label. The only one
  // of the three that does, and it changes how a retry should be written.
  idempotentCreate: true,
};

const GLS_STATUS: Record<string, TrackingStatus> = {
  PREADVICE: "pre_transit",
  INTRANSIT: "in_transit",
  INWAREHOUSE: "in_transit",
  OUTFORDELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
  DELIVERYFAILED: "exception",
  RETURNED: "returned",
};

const SERVICE_PRODUCT: Record<Shipment["serviceLevel"], string> = {
  standard: "PARCEL",
  express: "EXPRESS",
  next_day: "EXPRESS",
};

interface GlsErrorBody {
  exceptionText?: string;
  exceptionCode?: string;
  errors?: Array<{ field?: string; message?: string }>;
}

interface GlsShipmentResponse {
  consignmentId?: string;
  parcels?: Array<{ trackId?: string; parcelNumber?: string; location?: string }>;
  labels?: Array<{ data?: string; type?: string }>;
}

interface GlsTrackingResponse {
  tuStatus?: Array<{
    tuNo?: string;
    progressBar?: { statusInfo?: string; statusBar?: Array<{ status?: string }> };
    history?: Array<{
      evtDscr?: string;
      date?: string;
      time?: string;
      address?: { city?: string; countryName?: string };
      evtCode?: string;
    }>;
    estimatedDelivery?: string;
  }>;
}

export function glsCarrier(config: GlsConfig): Carrier {
  const now = config.now ?? (() => new Date());
  const basic = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");

  const kindFor = (status: number) => {
    if (status === 401 || status === 403) return "auth" as const;
    if (status === 400 || status === 409 || status === 422) return "validation" as const;
    if (status === 429) return "rate_limit" as const;
    if (status >= 500) return "carrier_down" as const;
    return "unknown" as const;
  };

  /** Pull the real reason out of the nested body, falling back to the status. */
  const raise = (status: number, body: string, what: string): never => {
    let parsed: GlsErrorBody = {};
    try {
      parsed = JSON.parse(body) as GlsErrorBody;
    } catch {
      // Not JSON. The status is all we have.
    }
    const fields = (parsed.errors ?? []).map((e) => e.field ?? "unknown");
    const detail = parsed.exceptionText
      ?? (parsed.errors ?? []).map((e) => e.message ?? "").filter((m) => m !== "").join("; ");
    throw new CarrierError(
      "gls",
      kindFor(status),
      `${what} failed with HTTP ${status}${detail === undefined || detail === "" ? "" : `: ${detail}`}`,
      { carrierCode: parsed.exceptionCode ?? String(status), fields },
    );
  };

  return {
    id: "gls",
    capabilities: GLS_CAPABILITIES,

    async createLabel(shipment: Shipment): Promise<Label> {
      const res = await config.transport.send({
        url: `${config.baseUrl}/shipments`,
        method: "POST",
        headers: {
          "content-type": "application/glsVersion1+json",
          accept: "application/glsVersion1+json",
          authorization: basic,
        },
        body: JSON.stringify({
          shipperId: config.contactId,
          shipmentReference: [shipment.reference],
          product: SERVICE_PRODUCT[shipment.serviceLevel],
          addresses: {
            delivery: {
              name1: shipment.recipient.name,
              name2: shipment.recipient.company,
              street1: shipment.recipient.street,
              blockNo1: shipment.recipient.houseNumber,
              zipCode: shipment.recipient.postcode,
              city: shipment.recipient.city,
              country: shipment.recipient.countryCode,
              email: shipment.recipient.email,
              phone: shipment.recipient.phone,
            },
          },
          parcels: shipment.parcels.map((parcel) => ({
            weight: parcel.weightGrams / 1000,
            reference: [parcel.reference ?? shipment.reference],
            comment: parcel.reference,
          })),
          labelFormat: "PDF",
        }),
      });

      if (res.status >= 400) raise(res.status, res.body, "label request");

      let body: GlsShipmentResponse;
      try {
        body = JSON.parse(res.body) as GlsShipmentResponse;
      } catch (cause) {
        throw new CarrierError("gls", "unknown", "response was not JSON", { cause });
      }

      const labelData = body.labels?.[0]?.data ?? "";
      const parcels: ParcelLabel[] = (body.parcels ?? []).map((parcel) => ({
        trackingNumber: parcel.trackId ?? parcel.parcelNumber ?? "",
        labelFormat: (body.labels?.[0]?.type ?? "pdf").toLowerCase() === "zpl" ? "zpl" : "pdf",
        labelData,
      }));
      if (parcels.length === 0) {
        throw new CarrierError("gls", "unknown", "response contained no parcels");
      }

      return {
        carrier: "gls",
        consignmentId: body.consignmentId ?? (parcels[0]?.trackingNumber ?? ""),
        parcels,
        costMinorUnits: null,
        currency: null,
        createdAt: now().toISOString(),
      };
    },

    async track(trackingNumber: string): Promise<Tracking> {
      const res = await config.transport.send({
        url: `${config.baseUrl}/tracking/${encodeURIComponent(trackingNumber)}`,
        method: "GET",
        headers: { accept: "application/glsVersion1+json", authorization: basic },
      });

      if (res.status === 404) {
        throw new CarrierError("gls", "validation", `tracking id ${trackingNumber} is not known`, {
          carrierCode: "404",
        });
      }
      if (res.status >= 400) raise(res.status, res.body, "tracking request");

      const body = JSON.parse(res.body) as GlsTrackingResponse;
      const unit = body.tuStatus?.[0];
      if (unit === undefined) {
        throw new CarrierError("gls", "validation", `no tracking unit returned for ${trackingNumber}`);
      }

      const events: TrackingEvent[] = (unit.history ?? []).map((entry) => {
        const code = (entry.evtCode ?? "").toUpperCase();
        const event: TrackingEvent = {
          status: GLS_STATUS[code] ?? "in_transit",
          carrierCode: code,
          description: entry.evtDscr ?? "",
          // GLS splits date and time into two fields. Joined into one ISO-ish
          // stamp so callers do not each invent their own concatenation.
          occurredAt: entry.date === undefined ? "" : `${entry.date}T${entry.time ?? "00:00:00"}`,
        };
        const city = entry.address?.city;
        if (city !== undefined && city !== "") event.location = city;
        return event;
      });

      const bar = unit.progressBar?.statusBar ?? [];
      const latestFromBar = (bar[bar.length - 1]?.status ?? "").toUpperCase();
      const latest = GLS_STATUS[latestFromBar] ?? events[events.length - 1]?.status ?? "in_transit";

      const tracking: Tracking = { carrier: "gls", trackingNumber, status: latest, events };
      if (unit.estimatedDelivery !== undefined) tracking.estimatedDelivery = unit.estimatedDelivery;
      return tracking;
    },
  };
}
