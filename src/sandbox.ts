/**
 * Offline sandboxes: one `Transport` per carrier, answering with that
 * carrier's own response shape.
 *
 * These are not test doubles bolted on afterwards, they are how the package
 * is meant to be evaluated. Getting sandbox credentials from three carriers
 * takes weeks of account management, and nobody is going to do that to read
 * someone's repo.
 *
 * The payloads are modelled on each carrier's documented response shape and
 * are deliberately awkward in the places the real ones are: DHL returns
 * rejections inside HTTP 200, DPD lets a token expire and says "Fault
 * occured" about it, GLS buries the reason in a nested field. They are an
 * honest model of the shapes, not a substitute for the carriers' own docs.
 */

import type { Transport, TransportRequest, TransportResponse } from "./transport.ts";

export interface SandboxOptions {
  /**
   * Make the first authenticated DPD call fault with an expired token, so the
   * re-authenticate-and-retry path actually runs. On by default, because that
   * path is the one most likely to be wrong and the least likely to be
   * exercised by accident.
   */
  dpdExpireFirstToken?: boolean;
  /** Reject the DHL label with per-parcel validation messages inside a 200. */
  dhlRejectWithValidationMessages?: boolean;
  /** Fail the GLS call with this status and a nested exceptionText. */
  glsFailWith?: { status: number; exceptionText: string; field?: string };
}

const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const xml = (body: string): TransportResponse => ({
  status: 200,
  headers: { "content-type": "text/xml" },
  body,
});

/** A tiny deterministic base64 blob standing in for a label PDF. */
const FAKE_PDF = Buffer.from("%PDF-1.4 sandbox label").toString("base64");

/** Deterministic tracking numbers, so demo output and tests are stable. */
const trackingNumber = (carrier: string, reference: string, index: number): string => {
  let hash = 0;
  for (const char of `${carrier}:${reference}:${index}`) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_0;
  return `${carrier.toUpperCase()}${String(hash).padStart(8, "0")}`;
};

// ---------------------------------------------------------------- DHL -------

export function dhlSandbox(options: SandboxOptions = {}): Transport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      if (request.url.includes("/orders")) {
        const body = JSON.parse(request.body ?? "{}") as { shipments?: Array<{ refNo?: string }> };
        const shipments = body.shipments ?? [];

        if (options.dhlRejectWithValidationMessages === true) {
          // The trap: HTTP 200 with a rejected item.
          return json(200, {
            status: { statusCode: 207, title: "weak validation error" },
            items: shipments.map((s, i) => (i === 0
              ? {
                  sstatus: { statusCode: 400, title: "Bad request" },
                  validationMessages: [
                    { property: "consignee.postalCode", validationMessage: "postal code does not match the destination country" },
                  ],
                }
              : {
                  shipmentNo: trackingNumber("dhl", s.refNo ?? "ref", i),
                  sstatus: { statusCode: 200, title: "ok" },
                  label: { b64: FAKE_PDF, fileFormat: "PDF" },
                })),
          });
        }

        return json(200, {
          status: { statusCode: 200, title: "ok" },
          price: { value: 4.99 * shipments.length, currency: "EUR" },
          items: shipments.map((s, i) => ({
            shipmentNo: trackingNumber("dhl", s.refNo ?? "ref", i),
            sstatus: { statusCode: 200, title: "ok" },
            label: { b64: FAKE_PDF, fileFormat: "PDF" },
          })),
        });
      }

      if (request.url.includes("/shipments?trackingNumber=")) {
        const number = decodeURIComponent(request.url.split("trackingNumber=")[1] ?? "");
        if (number.startsWith("UNKNOWN")) return json(404, { status: 404, title: "not found" });
        return json(200, {
          shipments: [
            {
              id: number,
              status: { statusCode: "delivery", status: "out for delivery", timestamp: "2026-09-30T07:41:00Z" },
              estimatedTimeOfDelivery: "2026-09-30T18:00:00Z",
              events: [
                { statusCode: "pre-transit", description: "Order data received", timestamp: "2026-09-28T19:02:00Z", location: { address: { addressLocality: "Frankfurt am Main" } } },
                { statusCode: "transit", description: "Shipment processed in parcel centre", timestamp: "2026-09-29T02:14:00Z", location: { address: { addressLocality: "Obertshausen" } } },
                { statusCode: "delivery", description: "Out for delivery", timestamp: "2026-09-30T07:41:00Z", location: { address: { addressLocality: "Koeln" } } },
              ],
            },
          ],
        });
      }

      return json(404, { status: 404, title: "no sandbox route" });
    },
  };
}

// ---------------------------------------------------------------- DPD -------

export function dpdSandbox(options: SandboxOptions = {}): Transport {
  const expireFirst = options.dpdExpireFirstToken !== false;
  let issued = 0;
  let firstCallFaulted = false;

  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      if (request.url.includes("/LoginService/")) {
        issued += 1;
        return xml(
          `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
            `<ns:getAuthResponse xmlns:ns="http://dpd.com/common/service/types/LoginService/2.0"><return>` +
            `<delisId>SANDBOX01</delisId><authToken>token-${issued}</authToken><depot>0163</depot>` +
            `</return></ns:getAuthResponse></soap:Body></soap:Envelope>`,
        );
      }

      // Fault once, with DPD's own spelling, to exercise the retry.
      if (expireFirst && !firstCallFaulted) {
        firstCallFaulted = true;
        return xml(
          `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
            `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Fault occured</faultstring>` +
            `<detail><authenticationFault xmlns="http://dpd.com/common/service/types/Authentication/2.0">` +
            `<errorCode>LOGIN_8</errorCode></authenticationFault></detail>` +
            `</soap:Fault></soap:Body></soap:Envelope>`,
        );
      }

      if (request.url.includes("/ShipmentService/")) {
        const body = request.body ?? "";
        const references = [...body.matchAll(/<customerReferenceNumber1>([^<]*)<\/customerReferenceNumber1>/g)]
          .map((m) => m[1] ?? "");
        const mps = /<mpsCustomerReferenceNumber1>([^<]*)</.exec(body)?.[1] ?? "ref";
        const parcels = references
          .map(
            (ref, i) =>
              `<parcelInformation><parcelLabelNumber>${trackingNumber("dpd", ref, i)}</parcelLabelNumber></parcelInformation>`,
          )
          .join("");
        return xml(
          `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
            `<ns:storeOrdersResponse xmlns:ns="http://dpd.com/common/service/types/ShipmentService/3.2"><orderResult>` +
            `<shipmentResponses><identificationNumber>${mps}</identificationNumber>` +
            `<mpsId>MPS${trackingNumber("dpd", mps, 99)}</mpsId>${parcels}</shipmentResponses>` +
            // No price element anywhere. That is the real API's behaviour.
            `<parcellabelsPDF>${FAKE_PDF}</parcellabelsPDF>` +
            `</orderResult></ns:storeOrdersResponse></soap:Body></soap:Envelope>`,
        );
      }

      if (request.url.includes("/ParcelLifeCycleService/")) {
        const number = /<parcelLabelNumber>([^<]*)</.exec(request.body ?? "")?.[1] ?? "";
        if (number.startsWith("UNKNOWN")) {
          return xml(
            `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
              `<ns:getTrackingDataResponse xmlns:ns="http://dpd.com/common/service/types/ParcelLifeCycleService/2.0">` +
              `<trackingresult/></ns:getTrackingDataResponse></soap:Body></soap:Envelope>`,
          );
        }
        // Deliberately out of date order: the real service is depot-ordered.
        return xml(
          `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
            `<ns:getTrackingDataResponse xmlns:ns="http://dpd.com/common/service/types/ParcelLifeCycleService/2.0"><trackingresult>` +
            `<statusInfo><status>02</status><description>Parcel collected</description><date>2026-09-29T06:20:00</date><depotCity>Aschaffenburg</depotCity></statusInfo>` +
            `<statusInfo><status>13</status><description>Delivered to recipient</description><date>2026-09-30T11:05:00</date><depotCity>Bremen</depotCity></statusInfo>` +
            `<statusInfo><status>01</status><description>Order information received</description><date>2026-09-28T20:10:00</date><depotCity>Frankfurt am Main</depotCity></statusInfo>` +
            `</trackingresult></ns:getTrackingDataResponse></soap:Body></soap:Envelope>`,
        );
      }

      return xml(
        `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
          `<soap:Fault><faultstring>no sandbox route</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
      );
    },
  };
}

// ---------------------------------------------------------------- GLS -------

export function glsSandbox(options: SandboxOptions = {}): Transport {
  // ShipIT is idempotent on the shipment reference, so the sandbox is too:
  // posting the same reference twice returns the first consignment.
  const byReference = new Map<string, unknown>();

  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      if (request.url.endsWith("/shipments")) {
        const fail = options.glsFailWith;
        if (fail !== undefined) {
          return json(fail.status, {
            exceptionText: fail.exceptionText,
            exceptionCode: "SHIPIT_VALIDATION",
            errors: fail.field === undefined ? [] : [{ field: fail.field, message: fail.exceptionText }],
          });
        }

        const body = JSON.parse(request.body ?? "{}") as {
          shipmentReference?: string[];
          parcels?: Array<{ reference?: string[] }>;
        };
        const reference = body.shipmentReference?.[0] ?? "ref";
        const cached = byReference.get(reference);
        if (cached !== undefined) return json(200, cached);

        const response = {
          consignmentId: `GLSC${trackingNumber("gls", reference, 0).slice(3)}`,
          parcels: (body.parcels ?? []).map((_p, i) => ({
            trackId: trackingNumber("gls", reference, i),
            parcelNumber: `PN${trackingNumber("gls", reference, i).slice(3)}`,
          })),
          labels: [{ data: FAKE_PDF, type: "PDF" }],
        };
        byReference.set(reference, response);
        return json(200, response);
      }

      if (request.url.includes("/tracking/")) {
        const number = decodeURIComponent(request.url.split("/tracking/")[1] ?? "");
        if (number.startsWith("UNKNOWN")) return json(404, { exceptionText: "TU not found" });
        return json(200, {
          tuStatus: [
            {
              tuNo: number,
              progressBar: { statusInfo: "INTRANSIT", statusBar: [{ status: "PREADVICE" }, { status: "INTRANSIT" }] },
              estimatedDelivery: "2026-10-01",
              history: [
                { evtCode: "PREADVICE", evtDscr: "Data received", date: "2026-09-29", time: "18:30:00", address: { city: "Neuenstein" } },
                { evtCode: "INTRANSIT", evtDscr: "Parcel has left the depot", date: "2026-09-30", time: "04:12:00", address: { city: "Neuenstein" } },
              ],
            },
          ],
        });
      }

      return json(404, { exceptionText: "no sandbox route" });
    },
  };
}
