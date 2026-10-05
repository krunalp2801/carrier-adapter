/**
 * DHL, as a JSON REST API.
 *
 * The characteristic thing about this one is that failure arrives with HTTP
 * 200. A consignment posts, some parcels are accepted and some are rejected,
 * and the rejections are per-item `validationMessages` inside a successful
 * response. An adapter that checks `res.ok` and moves on will cheerfully
 * report a label it does not have.
 */

import { CarrierError } from "../errors.ts";
import type { Capabilities, Label, ParcelLabel, Shipment, Tracking, TrackingEvent, TrackingStatus } from "../domain.ts";
import type { Carrier, CarrierConfig } from "../carrier.ts";

export interface DhlConfig extends CarrierConfig {
  apiKey: string;
  billingNumber: string;
}

export const DHL_CAPABILITIES: Capabilities = {
  reportsCost: true,
  multiParcel: true,
  labelFormats: ["pdf", "zpl"],
  serviceLevels: ["standard", "express", "next_day"],
  tracking: true,
  idempotentCreate: false,
};

/** DHL's event codes, as far as this adapter cares. */
const DHL_STATUS: Record<string, TrackingStatus> = {
  "pre-transit": "pre_transit",
  "transit": "in_transit",
  "delivery": "out_for_delivery",
  "delivered": "delivered",
  "failure": "exception",
  "unknown": "exception",
};

const SERVICE_PRODUCT: Record<Shipment["serviceLevel"], string> = {
  standard: "V01PAK",
  express: "V01PRIO",
  next_day: "V06PAK",
};

interface DhlValidationMessage {
  property?: string;
  validationMessage?: string;
}

interface DhlItem {
  shipmentNo?: string;
  sstatus?: { statusCode?: number; title?: string; detail?: string };
  label?: { b64?: string; fileFormat?: string };
  validationMessages?: DhlValidationMessage[];
}

interface DhlOrderResponse {
  status?: { statusCode?: number; title?: string; detail?: string };
  items?: DhlItem[];
  /** Price block, present when the account is contracted for it. */
  price?: { value?: number; currency?: string };
}

interface DhlTrackingResponse {
  shipments?: Array<{
    id?: string;
    status?: { statusCode?: string; status?: string; description?: string; timestamp?: string; location?: { address?: { addressLocality?: string } } };
    estimatedTimeOfDelivery?: string;
    events?: Array<{
      statusCode?: string;
      status?: string;
      description?: string;
      timestamp?: string;
      location?: { address?: { addressLocality?: string } };
    }>;
  }>;
}

export function dhlCarrier(config: DhlConfig): Carrier {
  const now = config.now ?? (() => new Date());

  /** HTTP status to error kind. Separate so the mapping is testable. */
  const kindFor = (status: number) => {
    if (status === 401 || status === 403) return "auth" as const;
    if (status === 400 || status === 422) return "validation" as const;
    if (status === 429) return "rate_limit" as const;
    if (status >= 500) return "carrier_down" as const;
    return "unknown" as const;
  };

  return {
    id: "dhl",
    capabilities: DHL_CAPABILITIES,

    async createLabel(shipment: Shipment): Promise<Label> {
      const res = await config.transport.send({
        url: `${config.baseUrl}/orders?docFormat=PDF`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "dhl-api-key": config.apiKey,
        },
        body: JSON.stringify({
          profile: "STANDARD_GRUPPENPROFIL",
          shipments: shipment.parcels.map((parcel) => ({
            product: SERVICE_PRODUCT[shipment.serviceLevel],
            billingNumber: config.billingNumber,
            refNo: parcel.reference ?? shipment.reference,
            shipper: {
              name1: shipment.shipper.name,
              addressStreet: shipment.shipper.street,
              addressHouse: shipment.shipper.houseNumber,
              postalCode: shipment.shipper.postcode,
              city: shipment.shipper.city,
              country: shipment.shipper.countryCode,
            },
            consignee: {
              name1: shipment.recipient.name,
              addressStreet: shipment.recipient.street,
              addressHouse: shipment.recipient.houseNumber,
              postalCode: shipment.recipient.postcode,
              city: shipment.recipient.city,
              country: shipment.recipient.countryCode,
              email: shipment.recipient.email,
              phone: shipment.recipient.phone,
            },
            details: {
              weight: { uom: "g", value: parcel.weightGrams },
              dim: parcel.lengthCm === undefined
                ? undefined
                : { uom: "cm", length: parcel.lengthCm, width: parcel.widthCm, height: parcel.heightCm },
            },
          })),
        }),
      });

      if (res.status >= 400) {
        throw new CarrierError("dhl", kindFor(res.status), `label request failed with HTTP ${res.status}`, {
          carrierCode: String(res.status),
        });
      }

      let body: DhlOrderResponse;
      try {
        body = JSON.parse(res.body) as DhlOrderResponse;
      } catch (cause) {
        throw new CarrierError("dhl", "unknown", "response was not JSON", { cause });
      }

      const items = body.items ?? [];
      if (items.length === 0) {
        throw new CarrierError("dhl", "unknown", "response contained no items", {
          carrierCode: body.status?.title,
        });
      }

      // HTTP 200 with per-item rejections. This is the branch that matters.
      const rejected = items.filter((item) => (item.sstatus?.statusCode ?? 200) >= 400 || item.label?.b64 === undefined);
      if (rejected.length > 0) {
        const fields = rejected.flatMap((item) =>
          (item.validationMessages ?? []).map((m) => m.property ?? "unknown"),
        );
        const detail = rejected
          .flatMap((item) => (item.validationMessages ?? []).map((m) => m.validationMessage ?? ""))
          .filter((m) => m !== "")
          .join("; ");
        throw new CarrierError(
          "dhl",
          "validation",
          `${rejected.length} of ${items.length} parcel(s) rejected inside a 200 response${detail === "" ? "" : `: ${detail}`}`,
          { carrierCode: String(rejected[0]?.sstatus?.statusCode ?? 200), fields },
        );
      }

      const parcels: ParcelLabel[] = items.map((item) => ({
        trackingNumber: item.shipmentNo ?? "",
        labelFormat: (item.label?.fileFormat ?? "pdf").toLowerCase() === "zpl" ? "zpl" : "pdf",
        labelData: item.label?.b64 ?? "",
      }));

      const price = body.price?.value;
      return {
        carrier: "dhl",
        consignmentId: parcels[0]?.trackingNumber ?? "",
        parcels,
        // Rounded to minor units because a float euro amount on an invoice is
        // a rounding argument waiting to happen.
        costMinorUnits: price === undefined ? null : Math.round(price * 100),
        currency: price === undefined ? null : body.price?.currency ?? "EUR",
        createdAt: now().toISOString(),
      };
    },

    async track(trackingNumber: string): Promise<Tracking> {
      const res = await config.transport.send({
        url: `${config.baseUrl}/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`,
        method: "GET",
        headers: { accept: "application/json", "dhl-api-key": config.apiKey },
      });

      if (res.status === 404) {
        throw new CarrierError("dhl", "validation", `tracking number ${trackingNumber} is not known`, {
          carrierCode: "404",
        });
      }
      if (res.status >= 400) {
        throw new CarrierError("dhl", kindFor(res.status), `tracking request failed with HTTP ${res.status}`, {
          carrierCode: String(res.status),
        });
      }

      const body = JSON.parse(res.body) as DhlTrackingResponse;
      const shipment = body.shipments?.[0];
      if (shipment === undefined) {
        throw new CarrierError("dhl", "validation", `no shipment returned for ${trackingNumber}`);
      }

      const events: TrackingEvent[] = (shipment.events ?? []).map((event) => {
        const code = event.statusCode ?? "unknown";
        const mapped: TrackingEvent = {
          status: DHL_STATUS[code] ?? "in_transit",
          carrierCode: code,
          description: event.description ?? event.status ?? "",
          occurredAt: event.timestamp ?? "",
        };
        const location = event.location?.address?.addressLocality;
        if (location !== undefined) mapped.location = location;
        return mapped;
      });

      const latestCode = shipment.status?.statusCode ?? events[events.length - 1]?.carrierCode ?? "unknown";
      const tracking: Tracking = {
        carrier: "dhl",
        trackingNumber,
        status: DHL_STATUS[latestCode] ?? "in_transit",
        events,
      };
      if (shipment.estimatedTimeOfDelivery !== undefined) {
        tracking.estimatedDelivery = shipment.estimatedTimeOfDelivery;
      }
      return tracking;
    },
  };
}
