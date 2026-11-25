import {
  X509Certificate,
  createHash,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import { fetchWithLimit, IntegrationTransportError, parseHttpJson } from "./integration-http.js";
import {
  InvoiceProviderError,
  type DianCredentials,
  type FiscalTransmissionInput,
  type FiscalTransmissionResult,
  type InvoiceProvider,
} from "./invoice-types.js";

interface ExpectedDocument {
  readonly documentHash: string;
  readonly documentNumber?: string | undefined;
  readonly documentType?: "INVOICE" | "CREDIT_NOTE" | undefined;
}

interface XmlAttribute {
  readonly name: string;
  readonly prefix: string;
  readonly localName: string;
  readonly namespaceUri: string;
  readonly value: string;
}

interface XmlElement {
  readonly type: "element";
  readonly name: string;
  readonly prefix: string;
  readonly localName: string;
  readonly namespaceUri: string;
  readonly namespaceDeclarations: ReadonlyMap<string, string>;
  readonly namespaceContext: ReadonlyMap<string, string>;
  readonly attributes: readonly XmlAttribute[];
  readonly children: XmlNode[];
  parent: XmlElement | null;
}

interface XmlText {
  readonly type: "text";
  readonly value: string;
}

interface XmlComment {
  readonly type: "comment";
  readonly value: string;
}

interface XmlProcessingInstruction {
  readonly type: "pi";
  readonly target: string;
  readonly data: string;
}

type XmlNode = XmlElement | XmlText | XmlComment | XmlProcessingInstruction;

const cbcNamespace = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const dsigNamespace = "http://www.w3.org/2000/09/xmldsig#";
const c14nAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const exclusiveC14nAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
const envelopedTransform = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";

function invalidDocument(): InvoiceProviderError {
  return new InvoiceProviderError(
    "Accepted DIAN XML or its digital signature is invalid.",
    "INVALID_RESPONSE",
  );
}

function invalidCredential(message: string): InvoiceProviderError {
  return new InvoiceProviderError(message, "INVALID_CREDENTIAL");
}

function qualifiedName(value: string): { name: string; prefix: string; localName: string } {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/.test(value)) {
    throw invalidDocument();
  }
  const colon = value.indexOf(":");
  return colon === -1
    ? { name: value, prefix: "", localName: value }
    : { name: value, prefix: value.slice(0, colon), localName: value.slice(colon + 1) };
}

function decodeXml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|([A-Za-z]+));/g,
    (_match, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name) {
        const entity = entities[name];
        if (!entity) throw invalidDocument();
        return entity;
      }
      const codePoint = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint < 0x20 && ![9, 10, 13].includes(codePoint))
      ) {
        throw invalidDocument();
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function assertValidXmlText(value: string): void {
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/.test(value)) {
    throw invalidDocument();
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw invalidDocument();
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw invalidDocument();
}

function parseAttributes(source: string): { name: string; value: string }[] {
  const attributes: { name: string; value: string }[] = [];
  let offset = 0;
  while (offset < source.length) {
    const whitespace = /^\s+/.exec(source.slice(offset));
    if (whitespace) offset += whitespace[0].length;
    if (offset >= source.length) break;
    const match =
      /^([A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(
        source.slice(offset),
      );
    if (!match) throw invalidDocument();
    const rawValue = match[2] ?? match[3] ?? "";
    assertValidXmlText(rawValue);
    attributes.push({ name: match[1]!, value: decodeXml(rawValue) });
    offset += match[0].length;
  }
  return attributes;
}

function parseXml(source: string): XmlElement {
  const input = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const stack: XmlElement[] = [];
  const roots: XmlElement[] = [];
  let offset = 0;
  let nodeCount = 0;
  while (offset < input.length) {
    if (input.startsWith("<!--", offset)) {
      const end = input.indexOf("-->", offset + 4);
      if (end === -1 || input.slice(offset + 4, end).includes("--")) throw invalidDocument();
      const comment: XmlComment = { type: "comment", value: input.slice(offset + 4, end) };
      if (stack.length > 0) stack.at(-1)!.children.push(comment);
      offset = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", offset)) {
      if (stack.length === 0) throw invalidDocument();
      const end = input.indexOf("]]>", offset + 9);
      if (end === -1) throw invalidDocument();
      const value = input.slice(offset + 9, end);
      assertValidXmlText(value);
      stack.at(-1)!.children.push({ type: "text", value });
      offset = end + 3;
      continue;
    }
    if (input.startsWith("<?", offset)) {
      const end = input.indexOf("?>", offset + 2);
      if (end === -1) throw invalidDocument();
      const body = input.slice(offset + 2, end);
      const targetMatch = /^\s*([A-Za-z_][A-Za-z0-9._:-]*)(?:\s+([\s\S]*))?$/.exec(body);
      if (!targetMatch) throw invalidDocument();
      const target = targetMatch[1]!;
      if (target.toLowerCase() !== "xml" || offset !== 0 || roots.length > 0 || stack.length > 0) {
        throw invalidDocument();
      }
      offset = end + 2;
      continue;
    }
    if (input.startsWith("<!", offset)) throw invalidDocument();
    if (input.startsWith("</", offset)) {
      if (stack.length === 0) throw invalidDocument();
      const end = input.indexOf(">", offset + 2);
      if (end === -1) throw invalidDocument();
      const name = input.slice(offset + 2, end).trim();
      qualifiedName(name);
      const current = stack.at(-1)!;
      if (name !== current.name) throw invalidDocument();
      stack.pop();
      offset = end + 1;
      continue;
    }
    if (input[offset] === "<") {
      const end = tagEnd(input, offset + 1);
      let body = input.slice(offset + 1, end);
      if (body !== body.trimStart()) throw invalidDocument();
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1).trimEnd();
      const nameMatch = /^([A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?)/.exec(body);
      if (!nameMatch) throw invalidDocument();
      const parsedName = qualifiedName(nameMatch[1]!);
      const rawAttributes = parseAttributes(body.slice(nameMatch[0].length));
      if (new Set(rawAttributes.map((attribute) => attribute.name)).size !== rawAttributes.length) {
        throw invalidDocument();
      }
      if (stack.length >= 256 || ++nodeCount > 200_000) throw invalidDocument();
      const parent = stack.at(-1) ?? null;
      const inherited = parent?.namespaceContext ?? new Map([["xml", xmlNamespace]]);
      const declarations = new Map<string, string>();
      for (const attribute of rawAttributes) {
        if (
          (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) &&
          attribute.value === xmlNamespace
        ) {
          throw invalidDocument();
        }
        if (attribute.name === "xmlns") declarations.set("", attribute.value);
        if (attribute.name.startsWith("xmlns:")) {
          const prefix = attribute.name.slice(6);
          qualifiedName(prefix);
          if (!attribute.value) throw invalidDocument();
          declarations.set(prefix, attribute.value);
        }
      }
      const context = new Map(inherited);
      for (const [prefix, uri] of declarations) {
        if (prefix === "xml" && uri !== xmlNamespace) throw invalidDocument();
        context.set(prefix, uri);
      }
      const namespaceUri = parsedName.prefix
        ? context.get(parsedName.prefix)
        : (context.get("") ?? "");
      if (namespaceUri === undefined || namespaceUri === "http://www.w3.org/2000/xmlns/") {
        throw invalidDocument();
      }
      const attributes: XmlAttribute[] = [];
      const expandedNames = new Set<string>();
      for (const raw of rawAttributes) {
        if (raw.name === "xmlns" || raw.name.startsWith("xmlns:")) continue;
        const name = qualifiedName(raw.name);
        const attributeNamespace = name.prefix ? context.get(name.prefix) : "";
        if (attributeNamespace === undefined || attributeNamespace === xmlNamespace) {
          throw invalidDocument();
        }
        const expandedName = `${attributeNamespace}|${name.localName}`;
        if (expandedNames.has(expandedName)) throw invalidDocument();
        expandedNames.add(expandedName);
        attributes.push({ ...name, namespaceUri: attributeNamespace, value: raw.value });
      }
      const element: XmlElement = {
        type: "element",
        ...parsedName,
        namespaceUri,
        namespaceDeclarations: declarations,
        namespaceContext: context,
        attributes,
        children: [],
        parent,
      };
      if (parent) parent.children.push(element);
      else {
        if (roots.length > 0) throw invalidDocument();
        roots.push(element);
      }
      if (!selfClosing) stack.push(element);
      offset = end + 1;
      continue;
    }
    const next = input.indexOf("<", offset);
    const end = next === -1 ? input.length : next;
    const value = input.slice(offset, end);
    assertValidXmlText(value);
    if (stack.length === 0 && value.trim()) throw invalidDocument();
    if (stack.length > 0 && value) {
      stack.at(-1)!.children.push({ type: "text", value: decodeXml(value) });
    }
    offset = end;
  }
  if (stack.length > 0 || roots.length !== 1) throw invalidDocument();
  return roots[0]!;
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\r", "&#xD;");
}

function canonicalize(
  root: XmlElement,
  algorithm: typeof c14nAlgorithm | typeof exclusiveC14nAlgorithm,
): string {
  const render = (
    node: XmlNode,
    inheritedNamespaces: ReadonlyMap<string, string>,
    outputNamespaces: ReadonlyMap<string, string>,
  ): string => {
    if (node.type === "text") return escapeText(node.value);
    if (node.type === "comment") return "";
    if (node.type === "pi") return `<?${node.target}${node.data ? ` ${node.data}` : ""}?>`;
    const current = new Map(inheritedNamespaces);
    for (const [prefix, uri] of node.namespaceDeclarations) current.set(prefix, uri);
    const used = new Set<string>();
    if (algorithm === exclusiveC14nAlgorithm) {
      used.add(node.prefix || (node.namespaceUri ? "" : "__no_default__"));
      for (const attribute of node.attributes) {
        if (attribute.prefix) used.add(attribute.prefix);
      }
    }
    const declarations: { prefix: string; uri: string }[] = [];
    for (const [prefix, uri] of current) {
      if (prefix === "xml") continue;
      if (algorithm === exclusiveC14nAlgorithm && !used.has(prefix)) continue;
      if (outputNamespaces.get(prefix) === uri) continue;
      declarations.push({ prefix, uri });
    }
    declarations.sort((left, right) =>
      left.prefix === right.prefix
        ? left.uri < right.uri
          ? -1
          : left.uri > right.uri
            ? 1
            : 0
        : left.prefix < right.prefix
          ? -1
          : 1,
    );
    const emitted = new Map(outputNamespaces);
    for (const declaration of declarations) emitted.set(declaration.prefix, declaration.uri);
    const namespaceText = declarations
      .map(
        ({ prefix, uri }) => ` ${prefix ? `xmlns:${prefix}` : "xmlns"}="${escapeAttribute(uri)}"`,
      )
      .join("");
    const attributes = [...node.attributes].sort((left, right) =>
      left.namespaceUri === right.namespaceUri
        ? left.localName < right.localName
          ? -1
          : left.localName > right.localName
            ? 1
            : 0
        : left.namespaceUri < right.namespaceUri
          ? -1
          : 1,
    );
    const attributeText = attributes
      .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
      .join("");
    const children = node.children.map((child) => render(child, current, emitted)).join("");
    return `<${node.name}${namespaceText}${attributeText}>${children}</${node.name}>`;
  };
  const inherited = root.parent?.namespaceContext ?? new Map([["xml", xmlNamespace]]);
  return render(root, inherited, new Map());
}

function elements(root: XmlElement): XmlElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child.type === "element" ? elements(child) : [])),
  ];
}

function children(element: XmlElement, localName: string, namespaceUri: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement =>
      child.type === "element" &&
      child.localName === localName &&
      child.namespaceUri === namespaceUri,
  );
}

function one(elements: readonly XmlElement[]): XmlElement {
  if (elements.length !== 1) throw invalidDocument();
  return elements[0]!;
}

function attribute(element: XmlElement, name: string): string {
  const values = element.attributes.filter(
    (attribute) => attribute.localName === name && attribute.namespaceUri === "",
  );
  if (values.length !== 1) throw invalidDocument();
  return values[0]!.value;
}

function text(element: XmlElement): string {
  return element.children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "comment") return "";
      throw invalidDocument();
    })
    .join("");
}

function base64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (
    !compact ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) {
    throw invalidDocument();
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64") !== compact) throw invalidDocument();
  return decoded;
}

function trustAnchor(pem: string | null): X509Certificate {
  if (!pem) {
    throw invalidCredential("A DIAN signature trust anchor is required to accept signed XML.");
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw invalidCredential("The DIAN signature trust anchor is not a valid X.509 certificate.");
  }
  const now = Date.now();
  if (
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) < now ||
    certificate.publicKey.asymmetricKeyType !== "rsa" ||
    (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw invalidCredential(
      "The DIAN signature trust anchor is not a valid RSA signing certificate.",
    );
  }
  return certificate;
}

function digestAlgorithm(uri: string): "sha256" | "sha384" | "sha512" {
  const algorithms = {
    "http://www.w3.org/2001/04/xmlenc#sha256": "sha256",
    "http://www.w3.org/2001/04/xmldsig-more#sha384": "sha384",
    "http://www.w3.org/2001/04/xmlenc#sha512": "sha512",
  } as const;
  const algorithm = algorithms[uri as keyof typeof algorithms];
  if (!algorithm) throw invalidDocument();
  return algorithm;
}

function signatureAlgorithm(uri: string): "RSA-SHA256" | "RSA-SHA384" | "RSA-SHA512" {
  const algorithms = {
    "http://www.w3.org/2000/09/xmldsig#rsa-sha1": undefined,
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "RSA-SHA256",
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384": "RSA-SHA384",
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": "RSA-SHA512",
  } as const;
  const algorithm = algorithms[uri as keyof typeof algorithms];
  if (!algorithm) throw invalidDocument();
  return algorithm;
}

function verifyXmlDsig(
  root: XmlElement,
  signature: XmlElement,
  certificate: X509Certificate,
): void {
  const signedInfo = one(children(signature, "SignedInfo", dsigNamespace));
  const signatureValue = one(children(signature, "SignatureValue", dsigNamespace));
  const keyInfo = one(children(signature, "KeyInfo", dsigNamespace));
  const x509Data = one(children(keyInfo, "X509Data", dsigNamespace));
  const embeddedCertificate = base64(
    text(one(children(x509Data, "X509Certificate", dsigNamespace))),
  );
  if (
    embeddedCertificate.length !== certificate.raw.length ||
    !timingSafeEqual(embeddedCertificate, certificate.raw)
  ) {
    throw invalidDocument();
  }
  const canonicalization = one(children(signedInfo, "CanonicalizationMethod", dsigNamespace));
  const canonicalizationAlgorithm = attribute(canonicalization, "Algorithm");
  if (![c14nAlgorithm, exclusiveC14nAlgorithm].includes(canonicalizationAlgorithm)) {
    throw invalidDocument();
  }
  const signatureMethod = signatureAlgorithm(
    attribute(one(children(signedInfo, "SignatureMethod", dsigNamespace)), "Algorithm"),
  );
  const reference = one(children(signedInfo, "Reference", dsigNamespace));
  if (attribute(reference, "URI") !== "") throw invalidDocument();
  const transforms = one(children(reference, "Transforms", dsigNamespace));
  const transform = one(children(transforms, "Transform", dsigNamespace));
  if (attribute(transform, "Algorithm") !== envelopedTransform) throw invalidDocument();
  const digestMethod = digestAlgorithm(
    attribute(one(children(reference, "DigestMethod", dsigNamespace)), "Algorithm"),
  );
  const expectedDigest = base64(text(one(children(reference, "DigestValue", dsigNamespace))));
  const signatureBytes = base64(text(signatureValue));
  if (!signatureBytes.length || !expectedDigest.length) throw invalidDocument();

  const parent = signature.parent;
  if (!parent) throw invalidDocument();
  const index = parent.children.indexOf(signature);
  if (index < 0) throw invalidDocument();
  parent.children.splice(index, 1);
  const documentDigest = createHash(digestMethod)
    .update(canonicalize(root, c14nAlgorithm), "utf8")
    .digest();
  if (
    documentDigest.length !== expectedDigest.length ||
    !timingSafeEqual(documentDigest, expectedDigest)
  ) {
    throw invalidDocument();
  }
  const signedInfoBytes = Buffer.from(
    canonicalize(
      signedInfo,
      canonicalizationAlgorithm === exclusiveC14nAlgorithm ? exclusiveC14nAlgorithm : c14nAlgorithm,
    ),
    "utf8",
  );
  if (!verifySignature(signatureMethod, signedInfoBytes, certificate.publicKey, signatureBytes)) {
    throw invalidDocument();
  }
}

function assertSignedIdentity(
  signedXml: string,
  expected: ExpectedDocument,
  trustAnchorPem: string | null,
): void {
  const document = parseXml(signedXml);
  const expectedRoot = expected.documentType
    ? {
        INVOICE: {
          name: "Invoice",
          namespace: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
          scheme: "CUFE",
        },
        CREDIT_NOTE: {
          name: "CreditNote",
          namespace: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
          scheme: "CUDE",
        },
      }[expected.documentType]
    : null;
  if (
    (expectedRoot &&
      (document.localName !== expectedRoot.name ||
        document.namespaceUri !== expectedRoot.namespace)) ||
    (!expectedRoot && !["Invoice", "CreditNote"].includes(document.localName))
  ) {
    throw invalidDocument();
  }
  const scheme = expectedRoot?.scheme ?? (document.localName === "Invoice" ? "CUFE" : "CUDE");
  const documentId = one(children(document, "ID", cbcNamespace));
  const uuid = one(children(document, "UUID", cbcNamespace));
  if (
    !text(documentId) ||
    (expected.documentNumber !== undefined && text(documentId) !== expected.documentNumber) ||
    text(uuid) !== expected.documentHash ||
    attribute(uuid, "schemeName") !== scheme
  ) {
    throw invalidDocument();
  }
  const signatures = elements(document).filter(
    (element) => element.localName === "Signature" && element.namespaceUri === dsigNamespace,
  );
  verifyXmlDsig(document, one(signatures), trustAnchor(trustAnchorPem));
}

function parseResult(
  root: Record<string, unknown>,
  expected: ExpectedDocument,
  credentials: DianCredentials,
): FiscalTransmissionResult {
  if (root.status === "REJECTED")
    throw new InvoiceProviderError("The DIAN provider rejected the fiscal document.", "REJECTED");
  if (root.status !== "ACCEPTED")
    throw new InvoiceProviderError(
      "The DIAN provider returned an unsupported document status.",
      "INVALID_RESPONSE",
    );
  const providerDocumentId = root.providerDocumentId;
  const signedXml = root.signedXml;
  if (
    typeof providerDocumentId !== "string" ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(providerDocumentId) ||
    typeof signedXml !== "string" ||
    signedXml.length < 100 ||
    signedXml.length > 4_000_000 ||
    root.documentHash !== expected.documentHash
  ) {
    throw new InvoiceProviderError(
      "The DIAN provider response does not match the transmitted document.",
      "INVALID_RESPONSE",
    );
  }
  assertSignedIdentity(signedXml, expected, credentials.signatureTrustAnchorPem);
  return { providerDocumentId, signedXml };
}

export class DianInvoiceProvider implements InvoiceProvider {
  constructor(
    private readonly credentials: DianCredentials,
    private readonly options: {
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {}

  private async response(
    url: string,
    init: RequestInit,
    expected: ExpectedDocument,
  ): Promise<FiscalTransmissionResult | null> {
    try {
      const response = await fetchWithLimit({
        url,
        init: {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${this.credentials.bearerToken}`,
            accept: "application/json",
          },
        },
        fetchImpl: this.options.fetchImpl ?? fetch,
        timeoutMs: this.options.timeoutMs ?? 20_000,
        maximumBytes: 5_000_000,
      });
      if (response.status === 404) return null;
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500
      )
        throw new InvoiceProviderError(
          "DIAN transmission result is uncertain and requires reconciliation.",
          "NETWORK_UNCERTAIN",
        );
      if (response.status < 200 || response.status >= 300)
        throw new InvoiceProviderError(
          "The DIAN provider rejected the HTTP request.",
          "HTTP_ERROR",
        );
      return parseResult(parseHttpJson(response.body), expected, this.credentials);
    } catch (error) {
      if (error instanceof InvoiceProviderError) throw error;
      if (error instanceof IntegrationTransportError)
        throw new InvoiceProviderError(
          "DIAN transmission result is uncertain and requires reconciliation.",
          "NETWORK_UNCERTAIN",
        );
      throw error;
    }
  }

  async transmit(input: FiscalTransmissionInput): Promise<FiscalTransmissionResult> {
    const result = await this.response(
      `${this.credentials.providerUrl}/documents`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
        body: JSON.stringify(input),
      },
      input,
    );
    if (!result)
      throw new InvoiceProviderError("DIAN transmission returned no document.", "INVALID_RESPONSE");
    return result;
  }

  async find(
    documentHash: string,
    documentNumber?: string,
    documentType?: "INVOICE" | "CREDIT_NOTE",
  ): Promise<FiscalTransmissionResult | null> {
    if (!/^[0-9a-f]{96}$/.test(documentHash))
      throw new InvoiceProviderError("Fiscal document hash is invalid.", "INVALID_RESPONSE");
    return this.response(
      `${this.credentials.providerUrl}/documents/${encodeURIComponent(documentHash)}`,
      { method: "GET" },
      { documentHash, documentNumber, documentType },
    );
  }
}

export function signedDocumentHash(signedXml: string): Uint8Array<ArrayBuffer> {
  return createHash("sha256").update(signedXml, "utf8").digest();
}
