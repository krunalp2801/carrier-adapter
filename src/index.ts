/**
 * Public surface.
 */

export { normalizeAddress, normalizeCountry, splitHouseNumber, isShippable } from "./address.ts";
export type { Fix, NormalizeResult, Problem } from "./address.ts";
export { CarrierError } from "./errors.ts";
export type { ErrorKind } from "./errors.ts";
export { CarrierRegistry, CAPABILITIES, DEFAULT_ROUTING, registryFromEnv } from "./registry.ts";
export type { Routed, RoutingRule } from "./registry.ts";
export { dhlCarrier, DHL_CAPABILITIES } from "./carriers/dhl.ts";
export type { DhlConfig } from "./carriers/dhl.ts";
export { dpdCarrier, DPD_CAPABILITIES } from "./carriers/dpd.ts";
export type { DpdConfig } from "./carriers/dpd.ts";
export { glsCarrier, GLS_CAPABILITIES } from "./carriers/gls.ts";
export type { GlsConfig } from "./carriers/gls.ts";
export { dhlSandbox, dpdSandbox, glsSandbox } from "./sandbox.ts";
export type { SandboxOptions } from "./sandbox.ts";
export { httpTransport, recordingTransport } from "./transport.ts";
export type { Transport, TransportRequest, TransportResponse } from "./transport.ts";
export type { Carrier, CarrierConfig } from "./carrier.ts";
export { parseXml, find, findAll, textOf, escapeXml, XmlParseError } from "./xml.ts";
export type { XmlNode } from "./xml.ts";
export type {
  Address,
  Capabilities,
  CarrierId,
  CountryCode,
  Label,
  LabelFormat,
  Parcel,
  ParcelLabel,
  ServiceLevel,
  Shipment,
  Tracking,
  TrackingEvent,
  TrackingStatus,
} from "./domain.ts";
