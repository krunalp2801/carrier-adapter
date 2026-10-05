import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CarrierError } from "../src/errors.ts";
import { CarrierRegistry, DEFAULT_ROUTING, registryFromEnv } from "../src/registry.ts";
import type { RoutingRule } from "../src/registry.ts";
import { shipment } from "./helpers.ts";

const build = () => registryFromEnv({}).registry;

describe("registryFromEnv", () => {
  it("registers all three carriers with no credentials at all", () => {
    const { registry, live } = registryFromEnv({});
    assert.deepEqual(registry.ids(), ["dhl", "dpd", "gls"]);
    assert.deepEqual(live, []);
  });

  it("reports which carriers have live credentials", () => {
    const { live } = registryFromEnv({ DHL_API_KEY: "k", GLS_USERNAME: "u" });
    assert.deepEqual(live, ["dhl", "gls"]);
  });

  it("treats an empty credential as absent rather than live", () => {
    assert.deepEqual(registryFromEnv({ DPD_DELIS_ID: "" }).live, []);
  });

  it("is usable end to end straight from an empty environment", async () => {
    const label = await build().get("dhl").createLabel(shipment());
    assert.ok(label.parcels[0]?.trackingNumber);
  });
});

describe("CarrierRegistry", () => {
  it("looks a carrier up by id", () => {
    assert.equal(build().get("gls").id, "gls");
  });

  it("throws a clear error for a carrier that is not registered", () => {
    const registry = new CarrierRegistry([build().get("dpd")], DEFAULT_ROUTING, "dpd");
    assert.throws(() => registry.get("dhl"), /"dhl" is not registered/);
  });

  it("refuses to be built with a fallback it does not hold", () => {
    assert.throws(
      () => new CarrierRegistry([build().get("dhl")], DEFAULT_ROUTING, "dpd"),
      /fallback carrier "dpd" was not registered/,
    );
  });

  it("names the carriers that can report a cost", () => {
    assert.deepEqual(build().reportingCost(), ["dhl"]);
  });
});

describe("routing", () => {
  it("falls through to the default with a reason", () => {
    const routed = build().route(shipment());
    assert.equal(routed.carrier.id, "dpd");
    assert.match(routed.reason, /no rule matched/);
  });

  it("sends an international shipment to DHL", () => {
    const routed = build().route(shipment({ recipient: { ...shipment().recipient, countryCode: "FR" } }));
    assert.equal(routed.carrier.id, "dhl");
    assert.match(routed.reason, /international/);
  });

  it("sends anything over 31.5 kg to DHL", () => {
    const routed = build().route(shipment({ parcels: [{ weightGrams: 32_000 }] }));
    assert.equal(routed.carrier.id, "dhl");
    assert.match(routed.reason, /31.5 kg/);
  });

  it("sends a multi-parcel domestic consignment to GLS", () => {
    const routed = build().route(shipment({ parcels: [{ weightGrams: 1000 }, { weightGrams: 1000 }] }));
    assert.equal(routed.carrier.id, "gls");
  });

  it("applies the first matching rule, so order is the priority", () => {
    // International and multi-parcel both match; international is listed first.
    const routed = build().route(
      shipment({
        recipient: { ...shipment().recipient, countryCode: "FR" },
        parcels: [{ weightGrams: 1000 }, { weightGrams: 1000 }],
      }),
    );
    assert.equal(routed.carrier.id, "dhl");
  });

  it("accepts a custom rule list, because real routing is a commercial question", () => {
    const rules: RoutingRule[] = [
      { reason: "everything goes GLS this week", carrier: "gls", matches: () => true },
    ];
    const registry = new CarrierRegistry([build().get("dhl"), build().get("dpd"), build().get("gls")], rules, "dpd");
    assert.equal(registry.route(shipment()).carrier.id, "gls");
  });

  it("skips a rule naming a carrier that is not registered", () => {
    const rules: RoutingRule[] = [
      { reason: "would prefer dhl", carrier: "dhl", matches: () => true },
      { reason: "but gls is here", carrier: "gls", matches: () => true },
    ];
    const registry = new CarrierRegistry([build().get("gls")], rules, "gls");
    assert.equal(registry.route(shipment()).carrier.id, "gls");
  });

  it("totals weight across parcels rather than looking at the largest", () => {
    const routed = build().route(shipment({ parcels: [{ weightGrams: 16_000 }, { weightGrams: 16_000 }] }));
    assert.equal(routed.carrier.id, "dhl");
  });
});

describe("one retry policy covers three carriers", () => {
  it("classifies every adapter's failures into the same kinds", async () => {
    // The payoff of the error mapping: a caller writes this once.
    const registry = registryFromEnv({}).registry;
    const results: Array<{ id: string; retryable: boolean }> = [];
    for (const id of registry.ids()) {
      try {
        await registry.get(id).track("UNKNOWN999");
        assert.fail(`${id} should have rejected an unknown tracking number`);
      } catch (err) {
        assert.ok(err instanceof CarrierError, `${id} threw something that was not a CarrierError`);
        results.push({ id, retryable: err.retryable });
      }
    }
    assert.deepEqual(results.map((r) => r.retryable), [false, false, false]);
  });
});
