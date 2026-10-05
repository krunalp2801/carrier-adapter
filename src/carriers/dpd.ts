/**
 * DPD Web Connect, as SOAP over HTTPS.
 *
 * Three things about this carrier shaped the whole package.
 *
 * 1. Auth is a two-step dance with a token that expires. You call the login
 *    service once with a delis id and a password, get back an `authToken`,
 *    and put that token in a SOAP header on every subsequent call. Nothing
 *    tells you how long it lasts.
 *
 * 2. When the token expires you do not get a 401. You get HTTP 200, a SOAP
 *    Fault, and the fault string "Fault occured" — misspelled, and generic
 *    enough to send you looking at your envelope instead of your token. I
 *    lost most of a day to that on a live integration. This adapter treats
 *    that string as an auth failure, drops the cached token and retries once,
 *    which is the behaviour I wish the first version had had.
 *
 * 3. It returns no price. Not zero, not null: the shipment service has no
 *    cost field, because pricing lives in the contract. That single fact is
 *    why `Label.costMinorUnits` is nullable and why `Capabilities` exists
 *    instead of a lowest-common-denominator interface.
 */

import { CarrierError } from "../errors.ts";
import { escapeXml, find, findAll, parseXml, textOf } from "../xml.ts";
import type { XmlNode } from "../xml.ts";
import type { Capabilities, Label, ParcelLabel, Shipment, Tracking, TrackingEvent, TrackingStatus } from "../domain.ts";
import type { Carrier, CarrierConfig } from "../carrier.ts";

export interface DpdConfig extends CarrierConfig {
  delisId: string;
  password: string;
  /** Web Connect is versioned in the URL and in the namespace. */
  version?: string;
}

export const DPD_CAPABILITIES: Capabilities = {
  // The one that matters. See the note at the top of this file.
  reportsCost: false,
  multiParcel: true,
  labelFormats: ["pdf"],
  serviceLevels: ["standard", "express"],
  // Web Connect's tracking service is provisioned separately from shipping and
  // is not enabled on every account. This adapter implements it; whether your
  // credentials can call it is a question for your DPD account manager.
  tracking: true,
  idempotentCreate: false,
};

/** DPD's parcel life cycle codes. */
const DPD_STATUS: Record<string, TrackingStatus> = {
  "01": "pre_transit",
  "02": "in_transit",
  "03": "in_transit",
  "08": "out_for_delivery",
  "13": "delivered",
  "14": "exception",
  "15": "returned",
};

const SERVICE_CODE: Record<Shipment["serviceLevel"], string> = {
  standard: "101",
  express: "102",
  next_day: "102",
};

/**
 * Fault strings that mean "your token is stale", including the famous one.
 *
 * Matching on a message rather than a code is unpleasant and I would rather
 * not, but DPD's fault code for an expired token is the same code it uses for
 * a malformed request, so the message is the only thing that distinguishes
 * them.
 */
const AUTH_FAULTS = [
  /fault occured/i,       // DPD's own spelling. Means the token expired.
  /invalid[ _-]?token/i,
  /token.*expired/i,
  /not authorized/i,
  /login.*failed/i,
];

const isAuthFault = (faultString: string): boolean => AUTH_FAULTS.some((re) => re.test(faultString));

const soapEnvelope = (header: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<soapenv:Header>${header}</soapenv:Header>` +
  `<soapenv:Body>${body}</soapenv:Body>` +
  `</soapenv:Envelope>`;

export function dpdCarrier(config: DpdConfig): Carrier {
  const now = config.now ?? (() => new Date());
  const version = config.version ?? "V3_2";

  // Cached across calls, cleared the moment a fault suggests it is stale.
  let authToken: string | null = null;

  /** Parse a response, raising a CarrierError for a SOAP Fault. */
  const parse = (body: string): XmlNode => {
    let root: XmlNode;
    try {
      root = parseXml(body);
    } catch (cause) {
      throw new CarrierError("dpd", "unknown", "response was not parseable XML", { cause });
    }
    const fault = find(root, "Fault");
    if (fault !== undefined) {
      const faultString = textOf(fault, "faultstring") || textOf(fault, "Reason") || "unspecified fault";
      const code = textOf(fault, "errorCode") || textOf(fault, "faultcode") || undefined;
      const kind = isAuthFault(faultString) ? "auth" : "validation";
      throw new CarrierError(
        "dpd",
        kind,
        kind === "auth"
          ? `authentication fault ("${faultString}"), which for Web Connect usually means the token expired`
          : `request rejected: ${faultString}`,
        code === undefined ? {} : { carrierCode: code },
      );
    }
    return root;
  };

  const login = async (): Promise<string> => {
    const res = await config.transport.send({
      url: `${config.baseUrl}/LoginService/${version}`,
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8", soapaction: "getAuth" },
      body: soapEnvelope(
        "",
        `<getAuth><delisId>${escapeXml(config.delisId)}</delisId>` +
          `<password>${escapeXml(config.password)}</password>` +
          `<messageLanguage>en_EN</messageLanguage></getAuth>`,
      ),
    });
    if (res.status >= 500) {
      throw new CarrierError("dpd", "carrier_down", `login service returned HTTP ${res.status}`);
    }
    const root = parse(res.body);
    const token = textOf(root, "authToken");
    if (token === "") {
      throw new CarrierError("dpd", "auth", "login succeeded but returned no authToken");
    }
    return token;
  };

  const tokenHeader = (token: string): string =>
    `<authentication xmlns="http://dpd.com/common/service/types/Authentication/2.0">` +
    `<delisId>${escapeXml(config.delisId)}</delisId>` +
    `<authToken>${escapeXml(token)}</authToken>` +
    `<messageLanguage>en_EN</messageLanguage>` +
    `</authentication>`;

  /**
   * Send an authenticated call, re-authenticating once on an auth fault.
   *
   * One retry, not a loop: if a fresh token also comes back faulted, the
   * problem is the credentials or the request, and retrying would just
   * hammer the login service.
   */
  const authenticated = async (path: string, soapAction: string, body: string): Promise<XmlNode> => {
    const attempt = async (token: string): Promise<XmlNode> => {
      const res = await config.transport.send({
        url: `${config.baseUrl}/${path}/${version}`,
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", soapaction: soapAction },
        body: soapEnvelope(tokenHeader(token), body),
      });
      if (res.status >= 500) {
        throw new CarrierError("dpd", "carrier_down", `${path} returned HTTP ${res.status}`);
      }
      return parse(res.body);
    };

    if (authToken === null) authToken = await login();
    try {
      return await attempt(authToken);
    } catch (err) {
      if (err instanceof CarrierError && err.kind === "auth") {
        authToken = null;
        authToken = await login();
        return attempt(authToken);
      }
      throw err;
    }
  };

  return {
    id: "dpd",
    capabilities: DPD_CAPABILITIES,

    async createLabel(shipment: Shipment): Promise<Label> {
      const parcels = shipment.parcels
        .map(
          (parcel) =>
            `<parcels><customerReferenceNumber1>${escapeXml(parcel.reference ?? shipment.reference)}` +
            `</customerReferenceNumber1><weight>${Math.max(1, Math.round(parcel.weightGrams / 10))}</weight></parcels>`,
        )
        .join("");

      const root = await authenticated(
        "ShipmentService",
        "storeOrders",
        `<storeOrders><printOptions><printOption><paperFormat>A6</paperFormat>` +
          `<printerLanguage>PDF</printerLanguage></printOption></printOptions>` +
          `<order><generalShipmentData><sendingDepot>0163</sendingDepot>` +
          `<product>${SERVICE_CODE[shipment.serviceLevel]}</product>` +
          `<mpsCustomerReferenceNumber1>${escapeXml(shipment.reference)}</mpsCustomerReferenceNumber1>` +
          `<sender><name1>${escapeXml(shipment.shipper.name)}</name1>` +
          `<street>${escapeXml(shipment.shipper.street)}</street>` +
          `<houseNo>${escapeXml(shipment.shipper.houseNumber ?? "")}</houseNo>` +
          `<country>${escapeXml(shipment.shipper.countryCode)}</country>` +
          `<zipCode>${escapeXml(shipment.shipper.postcode)}</zipCode>` +
          `<city>${escapeXml(shipment.shipper.city)}</city></sender>` +
          `<recipient><name1>${escapeXml(shipment.recipient.name)}</name1>` +
          `<street>${escapeXml(shipment.recipient.street)}</street>` +
          `<houseNo>${escapeXml(shipment.recipient.houseNumber ?? "")}</houseNo>` +
          `<country>${escapeXml(shipment.recipient.countryCode)}</country>` +
          `<zipCode>${escapeXml(shipment.recipient.postcode)}</zipCode>` +
          `<city>${escapeXml(shipment.recipient.city)}</city></recipient>` +
          `</generalShipmentData>${parcels}</order></storeOrders>`,
      );

      // Web Connect reports per-parcel faults in `faults` inside an otherwise
      // successful response, the same trap as DHL's validationMessages.
      const faults = findAll(root, "faults");
      if (faults.length > 0) {
        const messages = faults.map((f) => textOf(f, "faultCode") || "unknown").join("; ");
        throw new CarrierError("dpd", "validation", `order stored with faults: ${messages}`, {
          carrierCode: textOf(faults[0] as XmlNode, "faultCode") || undefined,
        });
      }

      const labelPdf = textOf(root, "parcellabelsPDF");
      const labelNodes = findAll(root, "parcelInformation");
      if (labelNodes.length === 0) {
        throw new CarrierError("dpd", "unknown", "response contained no parcelInformation");
      }

      const parcelLabels: ParcelLabel[] = labelNodes.map((node) => ({
        trackingNumber: textOf(node, "parcelLabelNumber"),
        labelFormat: "pdf",
        // Web Connect returns one PDF for the whole consignment rather than
        // one per parcel, so every parcel carries the same document. Reported
        // honestly rather than split, because splitting a PDF here would mean
        // taking a PDF library into a shipping adapter.
        labelData: labelPdf,
      }));

      return {
        carrier: "dpd",
        consignmentId: textOf(root, "mpsId") || (parcelLabels[0]?.trackingNumber ?? ""),
        parcels: parcelLabels,
        // Not an oversight. See the file header.
        costMinorUnits: null,
        currency: null,
        createdAt: now().toISOString(),
      };
    },

    async track(trackingNumber: string): Promise<Tracking> {
      const root = await authenticated(
        "ParcelLifeCycleService",
        "getTrackingData",
        `<getTrackingData><parcelLabelNumber>${escapeXml(trackingNumber)}</parcelLabelNumber></getTrackingData>`,
      );

      const statusNodes = findAll(root, "statusInfo");
      if (statusNodes.length === 0) {
        throw new CarrierError("dpd", "validation", `no tracking data for ${trackingNumber}`);
      }

      const events: TrackingEvent[] = statusNodes.map((node) => {
        const code = textOf(node, "status");
        const event: TrackingEvent = {
          status: DPD_STATUS[code] ?? "in_transit",
          carrierCode: code,
          description: textOf(node, "description") || textOf(node, "label"),
          occurredAt: textOf(node, "date"),
        };
        const depot = textOf(node, "depotCity") || textOf(node, "location");
        if (depot !== "") event.location = depot;
        return event;
      });

      // DPD does not flag which status is current, so the last one wins. The
      // list is depot-ordered, not strictly time-ordered, so sort first.
      const ordered = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const latest = ordered[ordered.length - 1];
      return {
        carrier: "dpd",
        trackingNumber,
        status: latest?.status ?? "in_transit",
        events: ordered,
      };
    },
  };
}
