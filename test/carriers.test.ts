import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dhlCarrier } from "../src/carriers/dhl.ts";
import { dpdCarrier } from "../src/carriers/dpd.ts";
import { glsCarrier } from "../src/carriers/gls.ts";
import { dhlSandbox, dpdSandbox, glsSandbox } from "../src/sandbox.ts";
import { CarrierError } from "../src/errors.ts";
import { recordingTransport } from "../src/transport.ts";
import { FIXED_NOW, jsonReply, scriptedTransport, shipment, xmlReply } from "./helpers.ts";

const dhl = (transport = dhlSandbox()) =>
  dhlCarrier({ baseUrl: "https://x/v2", transport, apiKey: "k", billingNumber: "b", now: FIXED_NOW });
const dpd = (transport = dpdSandbox()) =>
  dpdCarrier({ baseUrl: "https://x/services", transport, delisId: "D", password: "p", now: FIXED_NOW });
const gls = (transport = glsSandbox()) =>
  glsCarrier({ baseUrl: "https://x/rs", transport, username: "u", password: "p", contactId: "c", now: FIXED_NOW });

describe("every adapter satisfies the same contract", () => {
  const all = [
    { name: "dhl", make: () => dhl() },
    { name: "dpd", make: () => dpd() },
    { name: "gls", make: () => gls() },
  ];

  for (const { name, make } of all) {
    it(`${name}: returns a label with a tracking number and base64 data`, async () => {
      const label = await make().createLabel(shipment());
      assert.equal(label.carrier, name);
      assert.equal(label.parcels.length, 1);
      const parcel = label.parcels[0];
      assert.ok(parcel);
      assert.ok(parcel.trackingNumber.length > 0);
      assert.ok(parcel.labelData.length > 0);
      assert.ok(["pdf", "zpl"].includes(parcel.labelFormat));
      assert.equal(label.createdAt, "2026-09-29T08:00:00.000Z");
    });

    it(`${name}: reports cost consistently with its capabilities`, async () => {
      const carrier = make();
      const label = await carrier.createLabel(shipment());
      if (carrier.capabilities.reportsCost) {
        assert.equal(typeof label.costMinorUnits, "number");
        assert.ok(label.currency);
      } else {
        // The contract that matters: no cost means null, never 0.
        assert.equal(label.costMinorUnits, null);
        assert.equal(label.currency, null);
      }
    });

    it(`${name}: returns tracking with a normalised status`, async () => {
      const carrier = make();
      const label = await carrier.createLabel(shipment());
      const number = label.parcels[0]?.trackingNumber ?? "";
      const tracking = await carrier.track(number);
      assert.equal(tracking.trackingNumber, number);
      assert.ok(tracking.events.length > 0);
      const allowed = ["pre_transit", "in_transit", "out_for_delivery", "delivered", "exception", "returned"];
      assert.ok(allowed.includes(tracking.status), tracking.status);
      for (const event of tracking.events) {
        assert.ok(allowed.includes(event.status), event.status);
        assert.ok(event.carrierCode.length > 0, "the carrier's own code must be kept");
      }
    });

    it(`${name}: raises a typed CarrierError for an unknown tracking number`, async () => {
      await assert.rejects(() => make().track("UNKNOWN123"), (err: unknown) => {
        assert.ok(err instanceof CarrierError, "must be a CarrierError");
        assert.equal(err.carrier, name);
        assert.equal(err.kind, "validation");
        assert.equal(err.retryable, false);
        return true;
      });
    });

    it(`${name}: labels a multi-parcel consignment`, async () => {
      const label = await make().createLabel(
        shipment({ parcels: [{ weightGrams: 1000, reference: "a" }, { weightGrams: 2000, reference: "b" }] }),
      );
      assert.equal(label.parcels.length, 2);
      const numbers = label.parcels.map((p) => p.trackingNumber);
      assert.equal(new Set(numbers).size, 2, "each parcel needs its own tracking number");
    });
  }
});

describe("dhl", () => {
  it("sends the api key and the billing number", async () => {
    const transport = recordingTransport(dhlSandbox());
    await dhl(transport).createLabel(shipment());
    const sent = transport.sent[0];
    assert.equal(sent?.headers["dhl-api-key"], "k");
    assert.match(sent?.body ?? "", /"billingNumber":"b"/);
  });

  it("maps the service level to a product code", async () => {
    const transport = recordingTransport(dhlSandbox());
    await dhl(transport).createLabel(shipment({ serviceLevel: "express" }));
    assert.match(transport.sent[0]?.body ?? "", /V01PRIO/);
  });

  it("rounds the price to minor units", async () => {
    const label = await dhl().createLabel(shipment());
    assert.equal(label.costMinorUnits, 499);
    assert.equal(label.currency, "EUR");
  });

  it("catches a rejection hidden inside an HTTP 200", async () => {
    // The characteristic DHL failure. An adapter that trusts res.ok reports a
    // label it does not have.
    const carrier = dhl(dhlSandbox({ dhlRejectWithValidationMessages: true }));
    await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
      assert.ok(err instanceof CarrierError);
      assert.equal(err.kind, "validation");
      assert.deepEqual(err.fields, ["consignee.postalCode"]);
      assert.match(err.message, /inside a 200 response/);
      return true;
    });
  });

  it("maps http statuses onto error kinds", async () => {
    const cases: Array<[number, string, boolean]> = [
      [401, "auth", true],
      [400, "validation", false],
      [429, "rate_limit", true],
      [503, "carrier_down", true],
      [418, "unknown", false],
    ];
    for (const [status, kind, retryable] of cases) {
      const carrier = dhl(scriptedTransport([jsonReply(status, { title: "no" })]));
      await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
        assert.ok(err instanceof CarrierError);
        assert.equal(err.kind, kind, `HTTP ${status}`);
        assert.equal(err.retryable, retryable, `HTTP ${status}`);
        return true;
      });
    }
  });

  it("fails clearly when the body is not JSON", async () => {
    const carrier = dhl(scriptedTransport([{ status: 200, headers: {}, body: "<html>nope</html>" }]));
    await assert.rejects(() => carrier.createLabel(shipment()), /was not JSON/);
  });

  it("fails when a 200 contains no items at all", async () => {
    const carrier = dhl(scriptedTransport([jsonReply(200, { status: { title: "ok" }, items: [] })]));
    await assert.rejects(() => carrier.createLabel(shipment()), /no items/);
  });
});

describe("dpd", () => {
  it("logs in once and reuses the token", async () => {
    const transport = recordingTransport(dpdSandbox({ dpdExpireFirstToken: false }));
    const carrier = dpd(transport);
    await carrier.createLabel(shipment());
    await carrier.createLabel(shipment({ reference: "SO-2" }));
    const logins = transport.sent.filter((r) => r.url.includes("LoginService"));
    assert.equal(logins.length, 1, "the token should be cached across calls");
  });

  it("puts the token in a SOAP header, not the body", async () => {
    const transport = recordingTransport(dpdSandbox({ dpdExpireFirstToken: false }));
    await dpd(transport).createLabel(shipment());
    const call = transport.sent.find((r) => r.url.includes("ShipmentService"));
    assert.match(call?.body ?? "", /<soapenv:Header><authentication/);
    assert.match(call?.body ?? "", /<authToken>token-1<\/authToken>/);
    assert.equal(call?.headers["soapaction"], "storeOrders");
  });

  it('treats "Fault occured" as an expired token and retries once', async () => {
    // DPD's own spelling, and its most misleading message: it does not mean
    // the envelope is wrong, it means the token is stale.
    const transport = recordingTransport(dpdSandbox({ dpdExpireFirstToken: true }));
    const label = await dpd(transport).createLabel(shipment());
    assert.ok(label.parcels[0]?.trackingNumber);
    const logins = transport.sent.filter((r) => r.url.includes("LoginService"));
    assert.equal(logins.length, 2, "it should re-authenticate after the fault");
    assert.match(
      transport.sent[transport.sent.length - 1]?.body ?? "",
      /<authToken>token-2<\/authToken>/,
      "the retry must use the new token",
    );
  });

  it("gives up rather than looping when a fresh token also faults", async () => {
    const fault = xmlReply(
      `<soap:Envelope xmlns:soap="s"><soap:Body><soap:Fault><faultstring>Fault occured</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
    );
    const login = xmlReply(`<soap:Envelope xmlns:soap="s"><soap:Body><return><authToken>t</authToken></return></soap:Body></soap:Envelope>`);
    const transport = scriptedTransport([login, fault, login, fault, fault]);
    const carrier = dpd(transport);
    await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
      assert.ok(err instanceof CarrierError);
      assert.equal(err.kind, "auth");
      return true;
    });
    assert.ok(transport.sent.filter((r) => r.url.includes("LoginService")).length <= 2);
  });

  it("maps a non-auth fault to validation and keeps the fault string", async () => {
    const login = xmlReply(`<soap:Envelope xmlns:soap="s"><soap:Body><return><authToken>t</authToken></return></soap:Body></soap:Envelope>`);
    const fault = xmlReply(
      `<soap:Envelope xmlns:soap="s"><soap:Body><soap:Fault><faultstring>zipCode is invalid</faultstring>` +
        `<detail><errorCode>SRV_1234</errorCode></detail></soap:Fault></soap:Body></soap:Envelope>`,
    );
    const carrier = dpd(scriptedTransport([login, fault]));
    await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
      assert.ok(err instanceof CarrierError);
      assert.equal(err.kind, "validation");
      assert.equal(err.retryable, false);
      assert.equal(err.carrierCode, "SRV_1234");
      assert.match(err.message, /zipCode is invalid/);
      return true;
    });
  });

  it("escapes customer data so an ampersand cannot break the envelope", async () => {
    const transport = recordingTransport(dpdSandbox({ dpdExpireFirstToken: false }));
    await dpd(transport).createLabel(
      shipment({ recipient: { name: `Müller & Sons <GmbH>`, street: "Lindenallee", houseNumber: "7", postcode: "50667", city: "Koeln", countryCode: "DE" } }),
    );
    const call = transport.sent.find((r) => r.url.includes("ShipmentService"));
    assert.match(call?.body ?? "", /Müller &amp; Sons &lt;GmbH&gt;/);
    assert.ok(!(call?.body ?? "").includes("& Sons"), "a raw ampersand would make this invalid XML");
  });

  it("reports no cost, which is the real API's behaviour", async () => {
    const label = await dpd().createLabel(shipment());
    assert.equal(label.costMinorUnits, null);
    assert.equal(label.currency, null);
    assert.equal(dpd().capabilities.reportsCost, false);
  });

  it("sorts tracking events by date, because the service returns them depot-ordered", async () => {
    const carrier = dpd();
    const tracking = await carrier.track("DPD123");
    const dates = tracking.events.map((e) => e.occurredAt);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(tracking.status, "delivered", "the latest event decides the status");
  });

  it("maps a treated-as-500 response to carrier_down", async () => {
    const login = xmlReply(`<soap:Envelope xmlns:soap="s"><soap:Body><return><authToken>t</authToken></return></soap:Body></soap:Envelope>`);
    const carrier = dpd(scriptedTransport([login, { status: 503, headers: {}, body: "" }]));
    await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
      assert.ok(err instanceof CarrierError);
      assert.equal(err.kind, "carrier_down");
      assert.equal(err.retryable, true);
      return true;
    });
  });
});

describe("gls", () => {
  it("sends basic auth", async () => {
    const transport = recordingTransport(glsSandbox());
    await gls(transport).createLabel(shipment());
    const expected = "Basic " + Buffer.from("u:p").toString("base64");
    assert.equal(transport.sent[0]?.headers["authorization"], expected);
  });

  it("returns the original consignment when the same reference is posted twice", async () => {
    // ShipIT is idempotent on the shipment reference. It is the only one of
    // the three that is, which is why capabilities say so.
    const carrier = gls();
    const first = await carrier.createLabel(shipment());
    const second = await carrier.createLabel(shipment());
    assert.equal(second.consignmentId, first.consignmentId);
    assert.equal(second.parcels[0]?.trackingNumber, first.parcels[0]?.trackingNumber);
    assert.equal(carrier.capabilities.idempotentCreate, true);
  });

  it("buys a separate label for a different reference", async () => {
    const carrier = gls();
    const first = await carrier.createLabel(shipment());
    const second = await carrier.createLabel(shipment({ reference: "SO-999" }));
    assert.notEqual(second.consignmentId, first.consignmentId);
  });

  it("digs the real reason out of the nested exceptionText", async () => {
    const carrier = gls(glsSandbox({ glsFailWith: { status: 400, exceptionText: "zip code is not valid for the destination country", field: "delivery.zipCode" } }));
    await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
      assert.ok(err instanceof CarrierError);
      assert.equal(err.kind, "validation");
      assert.equal(err.carrierCode, "SHIPIT_VALIDATION");
      assert.deepEqual(err.fields, ["delivery.zipCode"]);
      assert.match(err.message, /zip code is not valid/);
      return true;
    });
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const carrier = gls(scriptedTransport([{ status: 500, headers: {}, body: "<html>502</html>" }]));
    await assert.rejects(() => carrier.createLabel(shipment()), (err: unknown) => {
      assert.ok(err instanceof CarrierError);
      assert.equal(err.kind, "carrier_down");
      assert.match(err.message, /HTTP 500/);
      return true;
    });
  });

  it("joins the split date and time fields into one stamp", async () => {
    const tracking = await gls().track("GLS123");
    assert.equal(tracking.events[0]?.occurredAt, "2026-09-29T18:30:00");
  });

  it("prefers the progress bar over the last history row for the current status", async () => {
    const tracking = await gls().track("GLS123");
    assert.equal(tracking.status, "in_transit");
    assert.equal(tracking.estimatedDelivery, "2026-10-01");
  });
});
