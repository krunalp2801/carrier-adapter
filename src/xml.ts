/**
 * A small XML reader, for DPD's SOAP responses.
 *
 * Not a general XML parser and not trying to be. It handles elements, text,
 * attributes, self-closing tags, comments, CDATA and the XML declaration,
 * strips namespace prefixes, and ignores everything else. That is enough for
 * a SOAP envelope and small enough to read in one sitting.
 *
 * Why not take a dependency: this package has zero runtime dependencies on
 * purpose, and it sits in the path of buying real shipping labels. Every
 * package added here is a package that can be compromised into an address
 * exfiltration. Seventy lines I can audit beat a transitive tree I cannot.
 *
 * The honest trade-off: this does not validate, does not resolve entities
 * beyond the five predefined ones, and would be the wrong choice for
 * arbitrary XML from an untrusted source. DPD's response shape is pinned by
 * the WSDL, which is what makes it defensible here.
 */

export interface XmlNode {
  /** Local name, namespace prefix removed. */
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Direct text content, trimmed. Empty when the node only has children. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function decodeEntities(raw: string): string {
  return raw.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    const named = ENTITIES[m];
    if (named !== undefined) return named;
    const code = m.startsWith("&#x") || m.startsWith("&#X")
      ? Number.parseInt(m.slice(3, -1), 16)
      : Number.parseInt(m.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** Strip a namespace prefix: `soap:Envelope` becomes `Envelope`. */
const localName = (raw: string): string => {
  const colon = raw.indexOf(":");
  return colon < 0 ? raw : raw.slice(colon + 1);
};

function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    if (name !== undefined && value !== undefined) out[localName(name)] = decodeEntities(value);
  }
  return out;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

/** Parse a document and return its root element. */
export function parseXml(source: string): XmlNode {
  // Strip the declaration, comments, doctype and CDATA markers. CDATA content
  // is kept as text, which is why it is unwrapped rather than dropped.
  const src = source
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner);

  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<\s*(\/?)\s*([\w:.-]+)((?:\s+[^<>]*?)?)\s*(\/?)\s*>/g;

  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src)) !== null) {
    const parent = stack[stack.length - 1];
    if (parent === undefined) throw new XmlParseError("unbalanced document");

    const between = src.slice(cursor, m.index);
    if (between.trim() !== "") parent.text += decodeEntities(between.trim());
    cursor = m.index + m[0].length;

    const closing = m[1] === "/";
    const name = localName(m[2] ?? "");
    const selfClosing = m[4] === "/";

    if (closing) {
      if (stack.length < 2) throw new XmlParseError(`unexpected closing tag </${name}>`);
      const open = stack[stack.length - 1];
      if (open !== undefined && open.name !== name) {
        throw new XmlParseError(`closing tag </${name}> does not match <${open.name}>`);
      }
      stack.pop();
      continue;
    }

    const node: XmlNode = { name, attributes: parseAttributes(m[3] ?? ""), children: [], text: "" };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) {
    const unclosed = stack[stack.length - 1];
    throw new XmlParseError(`unclosed tag <${unclosed?.name ?? "?"}>`);
  }
  const first = root.children[0];
  if (first === undefined) throw new XmlParseError("no root element");
  return first;
}

/** First descendant with this local name, depth first. */
export function find(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const deeper = find(child, name);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** Every descendant with this local name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    out.push(...findAll(child, name));
  }
  return out;
}

/** Text of the first descendant with this name, or "". */
export function textOf(node: XmlNode, name: string): string {
  return find(node, name)?.text ?? "";
}

/** Escape a value for insertion into an XML document. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
