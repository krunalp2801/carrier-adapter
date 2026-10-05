import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decodeEntities, escapeXml, find, findAll, parseXml, textOf, XmlParseError } from "../src/xml.ts";

describe("parseXml", () => {
  it("reads a root element with text", () => {
    const root = parseXml("<a>hello</a>");
    assert.equal(root.name, "a");
    assert.equal(root.text, "hello");
  });

  it("strips namespace prefixes from names and attributes", () => {
    const root = parseXml(`<soap:Envelope xmlns:soap="x" soap:role="next"><soap:Body/></soap:Envelope>`);
    assert.equal(root.name, "Envelope");
    assert.equal(root.attributes["role"], "next");
    assert.equal(root.children[0]?.name, "Body");
  });

  it("handles self-closing tags", () => {
    const root = parseXml("<a><b/><c/></a>");
    assert.deepEqual(root.children.map((c) => c.name), ["b", "c"]);
  });

  it("skips the declaration, comments and the doctype", () => {
    const root = parseXml(`<?xml version="1.0"?><!-- note --><!DOCTYPE a><a>x</a>`);
    assert.equal(root.name, "a");
    assert.equal(root.text, "x");
  });

  it("unwraps CDATA and keeps its contents as text", () => {
    assert.equal(parseXml("<a><![CDATA[1 < 2 & 3]]></a>").text, "1 < 2 & 3");
  });

  it("decodes entities in text and in attributes", () => {
    const root = parseXml(`<a t="x &amp; y">1 &lt; 2 &#65; &#x42;</a>`);
    assert.equal(root.text, "1 < 2 A B");
    assert.equal(root.attributes["t"], "x & y");
  });

  it("reads both quoting styles for attributes", () => {
    const root = parseXml(`<a one="1" two='2'/>`);
    assert.equal(root.attributes["one"], "1");
    assert.equal(root.attributes["two"], "2");
  });

  it("rejects a mismatched closing tag", () => {
    assert.throws(() => parseXml("<a><b></a></b>"), XmlParseError);
  });

  it("rejects an unclosed tag", () => {
    assert.throws(() => parseXml("<a><b></a>"), XmlParseError);
  });

  it("rejects a document with no root element", () => {
    assert.throws(() => parseXml("<?xml version='1.0'?>"), XmlParseError);
  });
});

describe("find, findAll and textOf", () => {
  const doc = parseXml(
    `<r><list><item><id>1</id></item><item><id>2</id></item></list><id>top</id></r>`,
  );

  it("finds the first descendant depth first", () => {
    assert.equal(find(doc, "id")?.text, "1");
  });

  it("finds every descendant", () => {
    assert.deepEqual(findAll(doc, "id").map((n) => n.text), ["1", "2", "top"]);
    assert.equal(findAll(doc, "item").length, 2);
  });

  it("returns undefined and an empty string for a name that is not there", () => {
    assert.equal(find(doc, "nope"), undefined);
    assert.equal(textOf(doc, "nope"), "");
  });
});

describe("escapeXml", () => {
  it("escapes the five characters that matter", () => {
    assert.equal(escapeXml(`<a href="x" & 'y'>`), "&lt;a href=&quot;x&quot; &amp; &apos;y&apos;&gt;");
  });

  it("round-trips through the parser", () => {
    // A customer called "Müller & Sons <GmbH>" must not break an envelope.
    const name = `Müller & Sons <GmbH> "Ltd" 'x'`;
    assert.equal(parseXml(`<n>${escapeXml(name)}</n>`).text, name);
  });

  it("is the inverse of decodeEntities for the predefined entities", () => {
    assert.equal(decodeEntities(escapeXml("<&>")), "<&>");
  });
});
