/**
 * The normalised domain model.
 *
 * This is the boundary. Everything above an adapter speaks these types;
 * everything inside an adapter speaks the carrier's own shapes and never lets
 * them out. Getting that line right is the whole value of the project: if a
 * DHL field name leaks into application code, adding GLS later means touching
 * the application.
 */

/** ISO 3166-1 alpha-2. Narrowed to a string for pragmatism, validated at the edge. */
export type CountryCode = string;

export interface Address {
  name: string;
  company?: string;
  street: string;
  /** Carried separately because DHL, DPD and GLS all want it as its own field. */
  houseNumber?: string;
  addition?: string;
  postcode: string;
  city: string;
  countryCode: CountryCode;
  email?: string;
  phone?: string;
}

export interface Parcel {
  /** Grams. Integer, because every carrier API wants an integer somewhere. */
  weightGrams: number;
  /** Centimetres. Optional: DPD will accept a parcel without them, DHL volumetric pricing will not. */
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  /** Merchant's own reference, echoed back on the label where the carrier supports it. */
  reference?: string;
}

export type ServiceLevel = "standard" | "express" | "next_day";

export interface Shipment {
  /** The merchant's id for this shipment. Used for idempotency where supported. */
  reference: string;
  shipper: Address;
  recipient: Address;
  parcels: Parcel[];
  serviceLevel: ServiceLevel;
  /** Cash on delivery and similar. Carried but only honoured where capabilities say so. */
  declaredValue?: { amount: number; currency: string };
}

export type LabelFormat = "pdf" | "zpl";

export interface ParcelLabel {
  trackingNumber: string;
  /** Base64. Format is reported rather than converted: nobody wants a silent re-render. */
  labelFormat: LabelFormat;
  labelData: string;
}

export interface Label {
  carrier: CarrierId;
  /** The carrier's id for the whole consignment, where it has one distinct from the parcel. */
  consignmentId: string;
  parcels: ParcelLabel[];
  /**
   * What the carrier says this shipment costs.
   *
   * Null is a real and common answer, not a failure. DPD's Web Connect
   * shipment service returns no price at all: pricing lives in the contract,
   * not in the API. Modelling this as `number` and defaulting to 0 would be a
   * lie that reaches an invoice, so it is nullable and
   * `capabilities.reportsCost` tells you in advance.
   */
  costMinorUnits: number | null;
  currency: string | null;
  createdAt: string;
}

/**
 * Tracking status, normalised.
 *
 * Six states, chosen because they are the ones a customer-facing message or a
 * support queue actually branches on. Carriers publish dozens of codes each
 * and no two agree; the raw code is kept alongside so nothing is lost.
 */
export type TrackingStatus =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "returned";

export interface TrackingEvent {
  status: TrackingStatus;
  /** The carrier's own code, kept so a support agent can quote it back. */
  carrierCode: string;
  description: string;
  location?: string;
  occurredAt: string;
}

export interface Tracking {
  carrier: CarrierId;
  trackingNumber: string;
  status: TrackingStatus;
  events: TrackingEvent[];
  /** Only some carriers promise one, and only some of the time. */
  estimatedDelivery?: string;
}

export type CarrierId = "dhl" | "dpd" | "gls";

/**
 * What a carrier can actually do.
 *
 * The alternative to this object is a lowest-common-denominator interface that
 * silently drops whatever the weakest carrier lacks. That is the standard way
 * to build an adapter layer and it is wrong: the caller ends up unable to tell
 * "this carrier does not report cost" from "this shipment was free".
 */
export interface Capabilities {
  /** Does `createLabel` come back with a price? DPD: no. */
  reportsCost: boolean;
  /** Can one call label several parcels as one consignment? */
  multiParcel: boolean;
  labelFormats: LabelFormat[];
  serviceLevels: ServiceLevel[];
  /** Is there a tracking endpoint we can actually call? */
  tracking: boolean;
  /** Does re-sending the same reference return the first label instead of a second one? */
  idempotentCreate: boolean;
}
