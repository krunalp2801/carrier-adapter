/**
 * Picking a carrier, and building the three from configuration.
 *
 * Routing is a list of rules evaluated in order with a fallback, rather than
 * a scoring function. A dispatch desk needs to be able to answer "why did
 * this go DPD" with one sentence, and a rule list gives you that sentence.
 */

import { dhlCarrier, DHL_CAPABILITIES } from "./carriers/dhl.ts";
import { dpdCarrier, DPD_CAPABILITIES } from "./carriers/dpd.ts";
import { glsCarrier, GLS_CAPABILITIES } from "./carriers/gls.ts";
import { dhlSandbox, dpdSandbox, glsSandbox } from "./sandbox.ts";
import { httpTransport } from "./transport.ts";
import type { Capabilities, CarrierId, Shipment } from "./domain.ts";
import type { Carrier } from "./carrier.ts";
import type { SandboxOptions } from "./sandbox.ts";

export const CAPABILITIES: Record<CarrierId, Capabilities> = {
  dhl: DHL_CAPABILITIES,
  dpd: DPD_CAPABILITIES,
  gls: GLS_CAPABILITIES,
};

export interface RoutingRule {
  /** Shown in the routing explanation, so write it for a human. */
  reason: string;
  carrier: CarrierId;
  matches(shipment: Shipment): boolean;
}

export interface Routed {
  carrier: Carrier;
  reason: string;
}

const totalWeight = (shipment: Shipment): number =>
  shipment.parcels.reduce((sum, parcel) => sum + parcel.weightGrams, 0);

/**
 * A plausible default, and an example of the shape rather than advice.
 *
 * Real routing is a commercial question: it depends on which contracts a
 * merchant holds and what each one charges per zone. Hard-coding my own
 * answer would be the wrong kind of opinionated, so this is three obvious
 * rules and a fallback, and the whole list is a constructor argument.
 */
export const DEFAULT_ROUTING: RoutingRule[] = [
  {
    reason: "international, and DHL is the only one of the three contracted outside the EU here",
    carrier: "dhl",
    matches: (s) => s.recipient.countryCode !== s.shipper.countryCode,
  },
  {
    reason: "over 31.5 kg, which is past the standard parcel limit",
    carrier: "dhl",
    matches: (s) => totalWeight(s) > 31_500,
  },
  {
    reason: "multi-parcel domestic consignment, and GLS returns the original label on a retry",
    carrier: "gls",
    matches: (s) => s.parcels.length > 1,
  },
];

export class CarrierRegistry {
  private readonly carriers: Map<CarrierId, Carrier>;
  private readonly rules: RoutingRule[];
  private readonly fallback: CarrierId;

  constructor(carriers: Carrier[], rules: RoutingRule[] = DEFAULT_ROUTING, fallback: CarrierId = "dpd") {
    this.carriers = new Map(carriers.map((carrier) => [carrier.id, carrier]));
    this.rules = rules;
    this.fallback = fallback;
    if (!this.carriers.has(fallback)) {
      throw new Error(`fallback carrier "${fallback}" was not registered`);
    }
  }

  ids(): CarrierId[] {
    return [...this.carriers.keys()];
  }

  get(id: CarrierId): Carrier {
    const carrier = this.carriers.get(id);
    if (carrier === undefined) throw new Error(`carrier "${id}" is not registered`);
    return carrier;
  }

  /** First matching rule wins. Returns the reason so it can be logged. */
  route(shipment: Shipment): Routed {
    for (const rule of this.rules) {
      if (rule.matches(shipment) && this.carriers.has(rule.carrier)) {
        return { carrier: this.get(rule.carrier), reason: rule.reason };
      }
    }
    return { carrier: this.get(this.fallback), reason: "no rule matched, so the default carrier" };
  }

  /** Carriers that can report what a shipment cost. Answers the obvious question. */
  reportingCost(): CarrierId[] {
    return this.ids().filter((id) => this.get(id).capabilities.reportsCost);
  }
}

/**
 * Build a registry from the environment.
 *
 * A carrier with no credentials gets its sandbox rather than being left out,
 * so the package is always fully functional and `npm run demo` works on a
 * fresh clone. Which carriers are live is reported rather than inferred.
 */
export function registryFromEnv(
  env: Record<string, string | undefined>,
  options: { sandbox?: SandboxOptions; now?: () => Date } = {},
): { registry: CarrierRegistry; live: CarrierId[] } {
  const live: CarrierId[] = [];
  const now = options.now;
  const sandbox = options.sandbox ?? {};

  const dhlKey = env["DHL_API_KEY"];
  const dhlLive = dhlKey !== undefined && dhlKey !== "";
  if (dhlLive) live.push("dhl");
  const dhl = dhlCarrier({
    baseUrl: env["DHL_API_URL"] ?? "https://sandbox.invalid/parcel/de/shipping/v2",
    transport: dhlLive ? httpTransport() : dhlSandbox(sandbox),
    apiKey: dhlKey ?? "sandbox",
    billingNumber: env["DHL_BILLING_NUMBER"] ?? "33333333330102",
    ...(now === undefined ? {} : { now }),
  });

  const dpdId = env["DPD_DELIS_ID"];
  const dpdLive = dpdId !== undefined && dpdId !== "";
  if (dpdLive) live.push("dpd");
  const dpd = dpdCarrier({
    baseUrl: env["DPD_API_URL"] ?? "https://sandbox.invalid/services",
    transport: dpdLive ? httpTransport() : dpdSandbox(sandbox),
    delisId: dpdId ?? "SANDBOX01",
    password: env["DPD_PASSWORD"] ?? "sandbox",
    ...(now === undefined ? {} : { now }),
  });

  const glsUser = env["GLS_USERNAME"];
  const glsLive = glsUser !== undefined && glsUser !== "";
  if (glsLive) live.push("gls");
  const gls = glsCarrier({
    baseUrl: env["GLS_API_URL"] ?? "https://sandbox.invalid/backend/rs",
    transport: glsLive ? httpTransport() : glsSandbox(sandbox),
    username: glsUser ?? "sandbox",
    password: env["GLS_PASSWORD"] ?? "sandbox",
    contactId: env["GLS_CONTACT_ID"] ?? "276de28a-1b2c-4d5e-8f90-sandbox",
    ...(now === undefined ? {} : { now }),
  });

  return { registry: new CarrierRegistry([dhl, dpd, gls]), live };
}
