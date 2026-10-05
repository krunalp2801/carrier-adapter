import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CarrierError } from "../src/errors.ts";
import type { ErrorKind } from "../src/errors.ts";

describe("CarrierError", () => {
  it("prefixes the message with the carrier", () => {
    assert.equal(new CarrierError("dpd", "auth", "token expired").message, "[dpd] token expired");
  });

  it("is an Error and keeps its name, so instanceof and logs both work", () => {
    const err = new CarrierError("gls", "validation", "bad zip");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof CarrierError);
    assert.equal(err.name, "CarrierError");
  });

  it("defaults fields to an empty list rather than undefined", () => {
    assert.deepEqual(new CarrierError("dhl", "unknown", "x").fields, []);
    assert.equal(new CarrierError("dhl", "unknown", "x").carrierCode, undefined);
  });

  it("keeps the carrier's own code and the offending fields", () => {
    const err = new CarrierError("gls", "validation", "bad zip", {
      carrierCode: "SHIPIT_VALIDATION",
      fields: ["delivery.zipCode"],
    });
    assert.equal(err.carrierCode, "SHIPIT_VALIDATION");
    assert.deepEqual(err.fields, ["delivery.zipCode"]);
  });

  it("preserves a cause", () => {
    const cause = new SyntaxError("Unexpected token");
    assert.equal(new CarrierError("dhl", "unknown", "not JSON", { cause }).cause, cause);
  });

  it("marks transient failures retryable and permanent ones not", () => {
    const expected: Array<[ErrorKind, boolean]> = [
      ["rate_limit", true],
      ["carrier_down", true],
      // Auth counts because the usual cause is an expired token and the
      // adapters re-authenticate on retry.
      ["auth", true],
      ["validation", false],
      // Deliberately not retryable: retrying something we failed to
      // understand is how a duplicate label gets bought.
      ["unknown", false],
    ];
    for (const [kind, retryable] of expected) {
      assert.equal(new CarrierError("dhl", kind, "x").retryable, retryable, kind);
    }
  });
});
