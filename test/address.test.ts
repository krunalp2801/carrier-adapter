import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isShippable, normalizeAddress, normalizeCountry, splitHouseNumber } from "../src/address.ts";
import type { Address } from "../src/domain.ts";

const address = (patch: Partial<Address> = {}): Address => ({
  name: "Test Person",
  street: "Teststrasse 1",
  postcode: "60311",
  city: "Frankfurt am Main",
  countryCode: "DE",
  phone: "+49 69 000000",
  ...patch,
});

const fixFor = (result: ReturnType<typeof normalizeAddress>, field: string) =>
  result.fixes.find((f) => f.field === field);
const errorFor = (result: ReturnType<typeof normalizeAddress>, field: string) =>
  result.problems.find((p) => p.field === field && p.severity === "error");

describe("normalizeCountry", () => {
  it("passes an alpha-2 code through, uppercased", () => {
    assert.equal(normalizeCountry("de"), "DE");
    assert.equal(normalizeCountry("  Fr  "), "FR");
  });

  it("maps country names, including German and French spellings", () => {
    assert.equal(normalizeCountry("Germany"), "DE");
    assert.equal(normalizeCountry("Deutschland"), "DE");
    assert.equal(normalizeCountry("Allemagne"), "DE");
    assert.equal(normalizeCountry("Österreich"), "AT");
    assert.equal(normalizeCountry("United Kingdom"), "GB");
  });

  it("maps alpha-3 codes", () => {
    assert.equal(normalizeCountry("DEU"), "DE");
    assert.equal(normalizeCountry("GBR"), "GB");
    assert.equal(normalizeCountry("NLD"), "NL");
  });

  it("returns null for something it does not recognise", () => {
    assert.equal(normalizeCountry("Atlantis"), null);
    assert.equal(normalizeCountry(""), null);
  });
});

describe("splitHouseNumber", () => {
  it("takes the number from the end for continental addresses", () => {
    assert.deepEqual(splitHouseNumber("Gartenstrasse 14", "DE"), { street: "Gartenstrasse", houseNumber: "14" });
    assert.deepEqual(splitHouseNumber("Bremer Weg 9a", "DE"), { street: "Bremer Weg", houseNumber: "9a" });
    assert.deepEqual(splitHouseNumber("Rue de la Paix 12-14", "FR"), { street: "Rue de la Paix", houseNumber: "12-14" });
  });

  it("takes the number from the front for the UK, Ireland and the US", () => {
    assert.deepEqual(splitHouseNumber("42 Mill Lane", "GB"), { street: "Mill Lane", houseNumber: "42" });
    assert.deepEqual(splitHouseNumber("1600 Pennsylvania Avenue", "US"), { street: "Pennsylvania Avenue", houseNumber: "1600" });
  });

  it("uses the country rather than the string, which is the whole point", () => {
    // "4 Seasons Road 12" is ambiguous read as a string. The country settles it.
    assert.deepEqual(splitHouseNumber("4 Seasons Road 12", "DE"), { street: "4 Seasons Road", houseNumber: "12" });
    assert.deepEqual(splitHouseNumber("4 Seasons Road 12", "GB"), { street: "Seasons Road 12", houseNumber: "4" });
  });

  it("leaves a street with no number alone", () => {
    assert.deepEqual(splitHouseNumber("Hauptstrasse", "DE"), { street: "Hauptstrasse" });
  });

  it("collapses whitespace inside a split number", () => {
    assert.deepEqual(splitHouseNumber("Gartenstrasse 14 a", "DE"), { street: "Gartenstrasse", houseNumber: "14a" });
  });
});

describe("normalizeAddress: country", () => {
  it("maps a country name and records the fix", () => {
    const r = normalizeAddress(address({ countryCode: "Germany" }));
    assert.equal(r.address.countryCode, "DE");
    assert.equal(fixFor(r, "countryCode")?.from, "Germany");
    assert.ok(isShippable(r));
  });

  it("records an error for a country it cannot map, without throwing", () => {
    const r = normalizeAddress(address({ countryCode: "Atlantis" }));
    assert.ok(errorFor(r, "countryCode"));
    assert.equal(isShippable(r), false);
  });
});

describe("normalizeAddress: the postcode and city swap", () => {
  it("swaps them back and says why", () => {
    const r = normalizeAddress(address({ postcode: "Koeln", city: "50667" }));
    assert.equal(r.address.postcode, "50667");
    assert.equal(r.address.city, "Koeln");
    assert.match(fixFor(r, "postcode/city")?.reason ?? "", /column drift/);
  });

  it("does not swap when the postcode field already holds a postcode", () => {
    // A town genuinely called 1000 must not drag a valid address apart.
    const r = normalizeAddress(address({ postcode: "60311", city: "1000" }));
    assert.equal(r.address.postcode, "60311");
    assert.equal(r.address.city, "1000");
    assert.equal(fixFor(r, "postcode/city"), undefined);
  });

  it("does not swap when neither field is a postcode", () => {
    const r = normalizeAddress(address({ postcode: "Koeln", city: "Bonn" }));
    assert.equal(fixFor(r, "postcode/city"), undefined);
    assert.ok(errorFor(r, "postcode"));
  });
});

describe("normalizeAddress: postcode formatting", () => {
  it("adds the space a UK postcode needs", () => {
    const r = normalizeAddress(address({ countryCode: "GB", postcode: "sw1a1aa", street: "42 Mill Lane" }));
    assert.equal(r.address.postcode, "SW1A 1AA");
    assert.ok(isShippable(r));
  });

  it("formats NL, PL, PT, SE, CZ and IE postcodes", () => {
    const cases: Array<[string, string, string, string]> = [
      ["NL", "1012AB", "1012 AB", "Damrak 1"],
      ["PL", "00001", "00-001", "Nowy Swiat 1"],
      ["PT", "1000001", "1000-001", "Rua Augusta 1"],
      ["SE", "11122", "111 22", "Drottninggatan 1"],
      ["CZ", "11000", "110 00", "Vaclavske namesti 1"],
      ["IE", "D02AF30", "D02 AF30", "1 Grafton Street"],
    ];
    for (const [countryCode, raw, expected, street] of cases) {
      const r = normalizeAddress(address({ countryCode, postcode: raw, street }));
      assert.equal(r.address.postcode, expected, `${countryCode} ${raw}`);
    }
  });

  it("reports a postcode it cannot salvage", () => {
    const r = normalizeAddress(address({ postcode: "8033" }));
    assert.ok(errorFor(r, "postcode"));
    assert.equal(isShippable(r), false);
  });

  it("leaves a country it has no format for alone", () => {
    const r = normalizeAddress(address({ countryCode: "BR", postcode: "01310-100", street: "Avenida Paulista 1000" }));
    assert.equal(r.address.postcode, "01310-100");
    assert.equal(errorFor(r, "postcode"), undefined);
  });
});

describe("normalizeAddress: house number", () => {
  it("splits it out of the street and records the fix", () => {
    const r = normalizeAddress(address({ street: "Gartenstrasse 14a", houseNumber: undefined }));
    assert.equal(r.address.street, "Gartenstrasse");
    assert.equal(r.address.houseNumber, "14a");
    assert.match(fixFor(r, "houseNumber")?.reason ?? "", /own field/);
  });

  it("leaves an explicit house number alone", () => {
    const r = normalizeAddress(address({ street: "Gartenstrasse", houseNumber: "14a" }));
    assert.equal(r.address.street, "Gartenstrasse");
    assert.equal(r.address.houseNumber, "14a");
    assert.equal(fixFor(r, "houseNumber"), undefined);
  });

  it("reports an error when there is no number anywhere", () => {
    const r = normalizeAddress(address({ street: "Hauptstrasse" }));
    assert.ok(errorFor(r, "houseNumber"));
    assert.equal(isShippable(r), false);
  });
});

describe("normalizeAddress: everything else", () => {
  it("collapses whitespace in every text field", () => {
    const r = normalizeAddress(address({ name: "  Anja   Weber ", city: " Frankfurt  am Main " }));
    assert.equal(r.address.name, "Anja Weber");
    assert.equal(r.address.city, "Frankfurt am Main");
  });

  it("warns about a missing phone number without blocking the shipment", () => {
    const r = normalizeAddress(address({ phone: undefined }));
    assert.equal(r.problems.find((p) => p.field === "phone")?.severity, "warning");
    assert.ok(isShippable(r));
  });

  it("errors on an empty name or city", () => {
    assert.ok(errorFor(normalizeAddress(address({ name: "  " })), "name"));
    assert.ok(errorFor(normalizeAddress(address({ city: "" })), "city"));
  });

  it("drops optional fields rather than carrying empty strings", () => {
    const r = normalizeAddress(address({ company: "  ", addition: "", email: " " }));
    assert.equal(r.address.company, undefined);
    assert.equal(r.address.addition, undefined);
    assert.equal(r.address.email, undefined);
  });

  it("records no fixes for an address that was already correct", () => {
    const r = normalizeAddress(address({ street: "Teststrasse", houseNumber: "1" }));
    assert.deepEqual(r.fixes, []);
    assert.ok(isShippable(r));
  });

  it("fixes four problems at once and stays shippable", () => {
    const r = normalizeAddress({
      name: "Harpreet Singh",
      street: "42 Mill Lane",
      postcode: "London",
      city: "sw1a1aa",
      countryCode: "United Kingdom",
      phone: "+44 20 7000 1111",
    });
    assert.equal(r.address.countryCode, "GB");
    assert.equal(r.address.postcode, "SW1A 1AA");
    assert.equal(r.address.city, "London");
    assert.equal(r.address.houseNumber, "42");
    assert.equal(r.address.street, "Mill Lane");
    assert.ok(isShippable(r));
  });
});
