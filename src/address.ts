/**
 * Address normalisation, run before any carrier is called.
 *
 * This module exists because of where the failure happens otherwise. A bad
 * address does not fail at checkout, it fails at label creation, which is
 * after the order is picked, packed and sitting on a bench. Someone then has
 * to find it, work out what is wrong, fix it and re-dispatch. I have done
 * that by hand more times than I would like, and the same four problems cause
 * almost all of it:
 *
 *   1. A country name or alpha-3 code in a field typed as alpha-2.
 *   2. The postcode and the city swapped, from column drift in a feed.
 *   3. The house number inside the street string, where DHL and DPD both
 *      want it as its own field and neither will split it for you.
 *   4. A postcode with the wrong spacing for its country.
 *
 * Every change is recorded as a `Fix` rather than applied silently. Quietly
 * rewriting a customer's address is how you ship to the wrong place and have
 * nothing to show for it afterwards.
 */

import type { Address } from "./domain.ts";

export interface Fix {
  field: string;
  from: string;
  to: string;
  /** Why this was changed, in words a support agent can read. */
  reason: string;
}

export interface Problem {
  field: string;
  /** `error` means a carrier will reject this. `warning` means it may. */
  severity: "error" | "warning";
  message: string;
}

export interface NormalizeResult {
  address: Address;
  fixes: Fix[];
  problems: Problem[];
}

/**
 * Country names and alpha-3 codes seen arriving in alpha-2 fields.
 *
 * Deliberately a lookup table rather than a library. The set of countries a
 * given merchant ships to is small and known, and a full ISO dataset is a
 * dependency that solves a problem nobody here has.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  AUSTRIA: "AT", OESTERREICH: "AT", ÖSTERREICH: "AT", AUT: "AT",
  BELGIUM: "BE", BELGIEN: "BE", BELGIQUE: "BE", BEL: "BE",
  SWITZERLAND: "CH", SCHWEIZ: "CH", SUISSE: "CH", CHE: "CH",
  CZECHIA: "CZ", "CZECH REPUBLIC": "CZ", TSCHECHIEN: "CZ", CZE: "CZ",
  GERMANY: "DE", DEUTSCHLAND: "DE", ALLEMAGNE: "DE", DEU: "DE", GER: "DE",
  DENMARK: "DK", DAENEMARK: "DK", DÄNEMARK: "DK", DNK: "DK",
  SPAIN: "ES", SPANIEN: "ES", ESPANA: "ES", ESPAÑA: "ES", ESP: "ES",
  FRANCE: "FR", FRANKREICH: "FR", FRA: "FR",
  "UNITED KINGDOM": "GB", "GREAT BRITAIN": "GB", ENGLAND: "GB",
  GROSSBRITANNIEN: "GB", GBR: "GB", UK: "GB",
  IRELAND: "IE", IRLAND: "IE", IRL: "IE",
  INDIA: "IN", INDIEN: "IN", IND: "IN",
  ITALY: "IT", ITALIEN: "IT", ITALIA: "IT", ITA: "IT",
  NETHERLANDS: "NL", NIEDERLANDE: "NL", HOLLAND: "NL", NLD: "NL",
  POLAND: "PL", POLEN: "PL", POLSKA: "PL", POL: "PL",
  PORTUGAL: "PT", PRT: "PT",
  SWEDEN: "SE", SCHWEDEN: "SE", SVERIGE: "SE", SWE: "SE",
  "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", USA: "US", "U.S.A.": "US",
};

interface PostcodeSpec {
  /** Matches an already-correct postcode. */
  valid: RegExp;
  /** Reformat a loosely-typed postcode, or null if it cannot be salvaged. */
  canonical?: (raw: string) => string | null;
}

const POSTCODES: Record<string, PostcodeSpec> = {
  AT: { valid: /^\d{4}$/ },
  BE: { valid: /^\d{4}$/ },
  CH: { valid: /^\d{4}$/ },
  CZ: {
    valid: /^\d{3} \d{2}$/,
    canonical: (raw) => (/^\d{5}$/.test(raw) ? `${raw.slice(0, 3)} ${raw.slice(3)}` : null),
  },
  DE: { valid: /^\d{5}$/ },
  DK: { valid: /^\d{4}$/ },
  ES: { valid: /^\d{5}$/ },
  FR: { valid: /^\d{5}$/ },
  GB: {
    // Outward code, space, inward code. The space is not cosmetic: GLS's
    // validator rejects the unspaced form outright.
    valid: /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/,
    canonical: (raw) => {
      const bare = raw.replace(/\s+/g, "");
      if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(bare)) return null;
      return `${bare.slice(0, bare.length - 3)} ${bare.slice(-3)}`;
    },
  },
  IE: { valid: /^[A-Z]\d{2} [A-Z\d]{4}$/, canonical: (raw) => {
    const bare = raw.replace(/\s+/g, "");
    return /^[A-Z]\d{2}[A-Z\d]{4}$/.test(bare) ? `${bare.slice(0, 3)} ${bare.slice(3)}` : null;
  } },
  IN: { valid: /^\d{6}$/ },
  IT: { valid: /^\d{5}$/ },
  NL: {
    valid: /^\d{4} [A-Z]{2}$/,
    canonical: (raw) => {
      const bare = raw.replace(/\s+/g, "");
      return /^\d{4}[A-Z]{2}$/.test(bare) ? `${bare.slice(0, 4)} ${bare.slice(4)}` : null;
    },
  },
  PL: {
    valid: /^\d{2}-\d{3}$/,
    canonical: (raw) => (/^\d{5}$/.test(raw) ? `${raw.slice(0, 2)}-${raw.slice(2)}` : null),
  },
  PT: {
    valid: /^\d{4}-\d{3}$/,
    canonical: (raw) => (/^\d{7}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null),
  },
  SE: {
    valid: /^\d{3} \d{2}$/,
    canonical: (raw) => (/^\d{5}$/.test(raw) ? `${raw.slice(0, 3)} ${raw.slice(3)}` : null),
  },
  US: { valid: /^\d{5}(-\d{4})?$/ },
};

const collapse = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Normalise a country field to alpha-2 where we can recognise it. */
export function normalizeCountry(raw: string): string | null {
  const cleaned = collapse(raw).toUpperCase();
  if (/^[A-Z]{2}$/.test(cleaned)) return cleaned;
  return COUNTRY_ALIASES[cleaned] ?? null;
}

/**
 * Split a street string into street and house number.
 *
 * Two conventions, and which one applies depends on the country, not on the
 * string. Continental Europe puts the number last ("Gartenstrasse 14a"),
 * the UK and Ireland put it first ("42 Mill Lane"). Guessing from the string
 * alone gets "4 Seasons Road" wrong, so the country decides.
 */
export function splitHouseNumber(
  street: string,
  countryCode: string,
): { street: string; houseNumber?: string } {
  const value = collapse(street);
  const numberFirst = countryCode === "GB" || countryCode === "IE" || countryCode === "US";

  if (numberFirst) {
    const m = /^(\d+[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?)\s+(.+)$/.exec(value);
    if (m?.[1] !== undefined && m[2] !== undefined) return { street: m[2], houseNumber: m[1] };
    return { street: value };
  }

  const m = /^(.*?[^\d\s])\s+(\d+\s?[a-zA-Z]?(?:\s*[-/]\s*\d+\s?[a-zA-Z]?)?)$/.exec(value);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return { street: m[1], houseNumber: m[2].replace(/\s+/g, "") };
  }
  return { street: value };
}

/** Does this look like a postcode for the given country? */
function looksLikePostcode(value: string, countryCode: string): boolean {
  const spec = POSTCODES[countryCode];
  const cleaned = collapse(value).toUpperCase();
  if (spec === undefined) return /^\d{4,6}$/.test(cleaned);
  if (spec.valid.test(cleaned)) return true;
  return spec.canonical?.(cleaned) !== null && spec.canonical?.(cleaned) !== undefined;
}

/**
 * Normalise an address and report everything that was changed or is still wrong.
 *
 * Never throws. A caller that wants to refuse a bad address checks `problems`
 * for `severity === "error"`; a caller that wants to ship anyway can.
 */
export function normalizeAddress(input: Address): NormalizeResult {
  const fixes: Fix[] = [];
  const problems: Problem[] = [];
  const note = (field: string, from: string, to: string, reason: string): void => {
    if (from !== to) fixes.push({ field, from, to, reason });
  };

  // --- country, first, because the other rules depend on it ----------------
  let countryCode = collapse(input.countryCode).toUpperCase();
  const resolved = normalizeCountry(input.countryCode);
  if (resolved === null) {
    problems.push({
      field: "countryCode",
      severity: "error",
      message: `"${input.countryCode}" is not a recognised country. Carriers need ISO 3166-1 alpha-2.`,
    });
  } else {
    note("countryCode", input.countryCode, resolved, "mapped to ISO 3166-1 alpha-2");
    countryCode = resolved;
  }

  // --- the swap, before either field is validated on its own ---------------
  let postcode = collapse(input.postcode).toUpperCase();
  let city = collapse(input.city);
  const postcodeWrong = !looksLikePostcode(postcode, countryCode);
  const cityLooksLikePostcode = looksLikePostcode(city, countryCode) && !/^\d/.test(postcode);
  if (postcodeWrong && cityLooksLikePostcode) {
    // Only swap when the postcode field is also not a postcode. Swapping on
    // the city test alone would wreck an address in a town called 1000.
    const swappedPostcode = city.toUpperCase();
    const swappedCity = collapse(input.postcode);
    fixes.push({
      field: "postcode/city",
      from: `${input.postcode} / ${input.city}`,
      to: `${swappedPostcode} / ${swappedCity}`,
      reason: "the two fields were swapped, most likely column drift in a feed",
    });
    postcode = swappedPostcode;
    city = swappedCity;
  }

  // --- postcode formatting -------------------------------------------------
  const spec = POSTCODES[countryCode];
  if (spec !== undefined && !spec.valid.test(postcode)) {
    const canonical = spec.canonical?.(postcode) ?? null;
    if (canonical !== null) {
      note("postcode", postcode, canonical, `reformatted to the ${countryCode} postcode layout`);
      postcode = canonical;
    } else {
      problems.push({
        field: "postcode",
        severity: "error",
        message: `"${postcode}" is not a valid ${countryCode} postcode.`,
      });
    }
  }
  if (postcode === "") {
    problems.push({ field: "postcode", severity: "error", message: "Postcode is empty." });
  }

  // --- street and house number --------------------------------------------
  let street = collapse(input.street);
  let houseNumber = input.houseNumber === undefined ? undefined : collapse(input.houseNumber);
  if (houseNumber === undefined || houseNumber === "") {
    const split = splitHouseNumber(street, countryCode);
    if (split.houseNumber !== undefined) {
      fixes.push({
        field: "houseNumber",
        from: street,
        to: `${split.street} + ${split.houseNumber}`,
        reason: "house number separated out, DHL and DPD both want it as its own field",
      });
      street = split.street;
      houseNumber = split.houseNumber;
    } else {
      problems.push({
        field: "houseNumber",
        severity: "error",
        message: `No house number found in "${street}" and none supplied separately.`,
      });
    }
  }

  // --- the rest ------------------------------------------------------------
  const name = collapse(input.name);
  if (name === "") problems.push({ field: "name", severity: "error", message: "Recipient name is empty." });
  if (city === "") problems.push({ field: "city", severity: "error", message: "City is empty." });

  const phone = input.phone === undefined ? undefined : collapse(input.phone);
  if (phone === undefined || phone === "") {
    problems.push({
      field: "phone",
      severity: "warning",
      message: "No phone number. Express services call the recipient before returning a parcel.",
    });
  }

  const address: Address = {
    name,
    street,
    postcode,
    city,
    countryCode,
  };
  if (input.company !== undefined && collapse(input.company) !== "") address.company = collapse(input.company);
  if (houseNumber !== undefined && houseNumber !== "") address.houseNumber = houseNumber;
  if (input.addition !== undefined && collapse(input.addition) !== "") address.addition = collapse(input.addition);
  if (input.email !== undefined && collapse(input.email) !== "") address.email = collapse(input.email);
  if (phone !== undefined && phone !== "") address.phone = phone;

  return { address, fixes, problems };
}

/** True when nothing in `problems` would make a carrier reject the shipment. */
export function isShippable(result: NormalizeResult): boolean {
  return !result.problems.some((p) => p.severity === "error");
}
