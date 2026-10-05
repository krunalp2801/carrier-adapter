/**
 * End-to-end demo against the three offline sandboxes.
 *
 * Run with `npm run demo`. No credentials, no network. CI runs this as a
 * smoke test, so it exits non-zero if the pipeline stops working.
 *
 * It walks the three things worth seeing: address normalisation fixing real
 * bad data, the same shipment going to three carriers through one interface,
 * and the capability asymmetry that a lowest-common-denominator API would
 * have hidden.
 */

import { isShippable, normalizeAddress } from "./address.ts";
import { CarrierError } from "./errors.ts";
import { registryFromEnv } from "./registry.ts";
import type { Address, CarrierId, Shipment } from "./domain.ts";

const SHIPPER: Address = {
  name: "Gift Bundle Supplies",
  street: "Hanauer Landstrasse",
  houseNumber: "126",
  postcode: "60314",
  city: "Frankfurt am Main",
  countryCode: "DE",
  phone: "+49 69 500000",
};

/** The four shapes of bad address data this package was written for. */
const MESSY_ADDRESSES: Array<{ label: string; address: Address }> = [
  {
    label: "country name in an alpha-2 field",
    address: { name: "Priya Shah", street: "Hauptstrasse 22", postcode: "10115", city: "Berlin", countryCode: "Germany", phone: "+49 30 111222" },
  },
  {
    label: "postcode and city swapped by column drift",
    address: { name: "Thomas Bauer", street: "Lindenallee 7", postcode: "Koeln", city: "50667", countryCode: "DE", phone: "+49 221 998877" },
  },
  {
    label: "house number inside the street string",
    address: { name: "Anja Weber", street: "Gartenstrasse 14a", postcode: "60594", city: "Frankfurt am Main", countryCode: "DEU", phone: "+49 69 1234567" },
  },
  {
    label: "UK postcode with no space, number first",
    address: { name: "Harpreet Singh", street: "42 Mill Lane", postcode: "sw1a1aa", city: "London", countryCode: "United Kingdom", phone: "+44 20 7000 1111" },
  },
  {
    label: "genuinely broken, no house number anywhere",
    address: { name: "M Keller", street: "Hauptstrasse", postcode: "8033", city: "Muenchen", countryCode: "DE" },
  },
];

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

async function main(): Promise<void> {
  const { registry, live } = registryFromEnv(process.env);

  console.log("carrier-adapter demo");
  console.log(`carriers: ${registry.ids().join(", ")}`);
  console.log(`live credentials: ${live.length === 0 ? "none, every carrier is on its sandbox" : live.join(", ")}\n`);

  // ---- 1. address normalisation ------------------------------------------
  console.log("1. address normalisation, before any carrier is called");
  console.log("-".repeat(78));
  let fixedCount = 0;
  let rejectedCount = 0;
  for (const { label, address } of MESSY_ADDRESSES) {
    const result = normalizeAddress(address);
    const shippable = isShippable(result);
    if (shippable && result.fixes.length > 0) fixedCount += 1;
    if (!shippable) rejectedCount += 1;

    console.log(`${label}`);
    for (const fix of result.fixes) {
      console.log(`  fixed  ${pad(fix.field, 16)} ${fix.from}  ->  ${fix.to}`);
    }
    for (const problem of result.problems.filter((p) => p.severity === "error")) {
      console.log(`  ERROR  ${pad(problem.field, 16)} ${problem.message}`);
    }
    console.log(`  ${shippable ? "shippable" : "held, a carrier would reject this at label time"}\n`);
  }

  // ---- 2. one shipment, three carriers -----------------------------------
  const recipient = normalizeAddress({
    name: "Thomas Bauer",
    street: "Lindenallee 7",
    postcode: "Koeln",
    city: "50667",
    countryCode: "DE",
    phone: "+49 221 998877",
  }).address;

  const shipment: Shipment = {
    reference: "SO-10042",
    shipper: SHIPPER,
    recipient,
    parcels: [{ weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15, reference: "SO-10042-1" }],
    serviceLevel: "standard",
  };

  console.log("2. the same shipment through all three adapters");
  console.log("-".repeat(78));
  console.log(`${pad("carrier", 8)} ${pad("tracking", 16)} ${pad("cost", 12)} ${pad("status", 18)} events`);

  const labelled: Array<{ id: CarrierId; trackingNumber: string }> = [];
  for (const id of registry.ids()) {
    const carrier = registry.get(id);
    const label = await carrier.createLabel(shipment);
    const first = label.parcels[0];
    if (first === undefined) throw new Error(`${id} returned a label with no parcels`);

    const tracking = await carrier.track(first.trackingNumber);
    labelled.push({ id, trackingNumber: first.trackingNumber });

    const cost = label.costMinorUnits === null
      ? "not reported"
      : `${(label.costMinorUnits / 100).toFixed(2)} ${label.currency ?? ""}`.trim();
    console.log(
      `${pad(id, 8)} ${pad(first.trackingNumber, 16)} ${pad(cost, 12)} ${pad(tracking.status, 18)} ${tracking.events.length}`,
    );
  }

  // ---- 3. the asymmetry the capability object exists to expose ------------
  console.log(`\n3. capabilities, because the three carriers are not interchangeable`);
  console.log("-".repeat(78));
  console.log(`${pad("carrier", 8)} ${pad("reports cost", 14)} ${pad("idempotent create", 19)} label formats`);
  for (const id of registry.ids()) {
    const caps = registry.get(id).capabilities;
    console.log(
      `${pad(id, 8)} ${pad(caps.reportsCost ? "yes" : "no", 14)} ${pad(caps.idempotentCreate ? "yes" : "no", 19)} ${caps.labelFormats.join(", ")}`,
    );
  }
  console.log(`\ncarriers that can tell you what a shipment cost: ${registry.reportingCost().join(", ") || "none"}`);
  console.log(`DPD reports no cost at all. Not zero, not an error: the shipment`);
  console.log(`service has no price field, because pricing lives in the contract.`);

  // ---- 4. routing --------------------------------------------------------
  console.log(`\n4. routing, with the reason`);
  console.log("-".repeat(78));
  const routingCases: Array<[string, Shipment]> = [
    ["domestic single parcel", shipment],
    ["two parcels", { ...shipment, parcels: [...shipment.parcels, { weightGrams: 1800 }] }],
    ["international", { ...shipment, recipient: { ...recipient, countryCode: "FR", postcode: "75001", city: "Paris" } }],
    ["over 31.5 kg", { ...shipment, parcels: [{ weightGrams: 32_000 }] }],
  ];
  for (const [label, candidate] of routingCases) {
    const routed = registry.route(candidate);
    console.log(`${pad(label, 24)} -> ${pad(routed.carrier.id, 5)} ${routed.reason}`);
  }

  // ---- 5. errors are typed, so one retry policy covers three carriers ----
  console.log(`\n5. a rejected label, mapped to a typed error`);
  console.log("-".repeat(78));
  const { registry: failing } = registryFromEnv(
    {},
    { sandbox: { glsFailWith: { status: 400, exceptionText: "zip code is not valid for the destination country", field: "delivery.zipCode" } } },
  );
  try {
    await failing.get("gls").createLabel(shipment);
    throw new Error("expected the GLS sandbox to reject this label");
  } catch (err) {
    if (!(err instanceof CarrierError)) throw err;
    console.log(`kind:      ${err.kind}`);
    console.log(`retryable: ${err.retryable}  (retrying unchanged would fail identically)`);
    console.log(`fields:    ${err.fields.join(", ")}`);
    console.log(`message:   ${err.message}`);
  }

  // ---- guard rails, so this works as a CI smoke test ---------------------
  if (labelled.length !== 3) throw new Error("expected a label from all three carriers");
  if (fixedCount < 3) throw new Error("address normalisation fixed almost nothing, so it is not working");
  if (rejectedCount < 1) throw new Error("the deliberately broken address was not held");
  if (registry.reportingCost().includes("dpd")) throw new Error("DPD must not claim to report cost");
  for (const { id, trackingNumber } of labelled) {
    if (trackingNumber === "") throw new Error(`${id} returned an empty tracking number`);
  }
  console.log(`\nok: 3 labels, ${fixedCount} addresses repaired, 1 held, typed errors across all three carriers.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
