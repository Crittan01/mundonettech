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
  readonly unsignedXml?: string | undefined;
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

const cacNamespace = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const cbcNamespace = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const invoiceNamespace = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const creditNoteNamespace = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
const dsigNamespace = "http://www.w3.org/2000/09/xmldsig#";
const c14nAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const exclusiveC14nAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
const envelopedTransform = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";
const singlePemCertificatePattern =
  /^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/]{1,76}\r?\n)*[A-Za-z0-9+/=]{1,76}\r?\n-----END CERTIFICATE-----$/;
const ncNamePattern = /^[A-Za-z_][A-Za-z0-9._-]*$/;

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

const xmlEntities = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decodeXml(value: string): string {
  return value.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|([A-Za-z]+));/g,
    (_match, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name) {
        const entity = xmlEntities.get(name);
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

function assertValidXmlControlChars(value: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw invalidDocument();
}

function assertValidXmlText(value: string): void {
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/.test(value)) {
    throw invalidDocument();
  }
  assertValidXmlControlChars(value);
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
    if (!whitespace) throw invalidDocument();
    offset += whitespace[0].length;
    if (offset >= source.length) break;
    const match =
      /^([A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(
        source.slice(offset),
      );
    if (!match) throw invalidDocument();
    const rawValue = match[2] ?? match[3] ?? "";
    if (rawValue.includes("<")) throw invalidDocument();
    assertValidXmlText(rawValue);
    const normalizedWhitespace = rawValue.replace(/[\t\n\r]/g, " ");
    attributes.push({ name: match[1]!, value: decodeXml(normalizedWhitespace) });
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
      const commentValue = end === -1 ? "" : input.slice(offset + 4, end);
      if (end === -1 || commentValue.includes("--") || commentValue.endsWith("-")) {
        throw invalidDocument();
      }
      assertValidXmlControlChars(commentValue);
      const comment: XmlComment = { type: "comment", value: commentValue };
      if (stack.length > 0) stack.at(-1)!.children.push(comment);
      offset = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", offset)) {
      if (stack.length === 0) throw invalidDocument();
      const end = input.indexOf("]]>", offset + 9);
      if (end === -1) throw invalidDocument();
      const value = input.slice(offset + 9, end);
      assertValidXmlControlChars(value);
      stack.at(-1)!.children.push({ type: "text", value });
      offset = end + 3;
      continue;
    }
    if (input.startsWith("<?", offset)) {
      const end = input.indexOf("?>", offset + 2);
      if (end === -1) throw invalidDocument();
      const body = input.slice(offset + 2, end);
      const targetMatch = /^([A-Za-z_][A-Za-z0-9._:-]*)(?:\s+([\s\S]*))?$/.exec(body);
      if (!targetMatch) throw invalidDocument();
      const target = targetMatch[1]!;
      if (target !== "xml" || offset !== 0 || roots.length > 0 || stack.length > 0) {
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
          (attribute.value === xmlNamespace || attribute.value === xmlnsNamespace)
        ) {
          throw invalidDocument();
        }
        if (attribute.name === "xmlns") declarations.set("", attribute.value);
        if (attribute.name.startsWith("xmlns:")) {
          const prefix = attribute.name.slice(6);
          if (!ncNamePattern.test(prefix) || prefix === "xmlns") throw invalidDocument();
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
      if (namespaceUri === undefined || namespaceUri === xmlnsNamespace) {
        throw invalidDocument();
      }
      const attributes: XmlAttribute[] = [];
      const expandedNames = new Set<string>();
      for (const raw of rawAttributes) {
        if (raw.name === "xmlns" || raw.name.startsWith("xmlns:")) continue;
        const name = qualifiedName(raw.name);
        const attributeNamespace = name.prefix ? context.get(name.prefix) : "";
        if (
          attributeNamespace === undefined ||
          attributeNamespace === xmlNamespace ||
          attributeNamespace === xmlnsNamespace
        ) {
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
      used.add(node.prefix);
      for (const attribute of node.attributes) {
        if (attribute.prefix) used.add(attribute.prefix);
      }
    }
    const declarations: { prefix: string; uri: string }[] = [];
    for (const [prefix, uri] of current) {
      if (prefix === "xml") continue;
      if (algorithm === exclusiveC14nAlgorithm && !used.has(prefix)) continue;
      if (prefix === "" && uri === "" && (outputNamespaces.get("") ?? "") === "") continue;
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

function elementChildren(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.type === "element");
}

function assertOnlyElementChildren(
  element: XmlElement,
  allowed: readonly (readonly [string, string])[],
): void {
  const allowedKeys = new Set(
    allowed.map(([localName, namespaceUri]) => `${namespaceUri}|${localName}`),
  );
  for (const child of elementChildren(element)) {
    if (!allowedKeys.has(`${child.namespaceUri}|${child.localName}`)) {
      throw invalidDocument();
    }
  }
}

function assertNoElementChildren(element: XmlElement): void {
  if (elementChildren(element).length !== 0) throw invalidDocument();
}

function trustAnchor(pem: string | null): X509Certificate {
  if (!pem) {
    throw invalidCredential("A DIAN signature trust anchor is required to accept signed XML.");
  }
  const trimmed = pem.trim();
  if (
    trimmed.length < 500 ||
    trimmed.length > 16_384 ||
    !singlePemCertificatePattern.test(trimmed)
  ) {
    throw invalidCredential("The DIAN signature trust anchor is not a valid X.509 certificate.");
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(trimmed);
  } catch {
    throw invalidCredential("The DIAN signature trust anchor is not a valid X.509 certificate.");
  }
  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  const keyUsageAllowed =
    !certificate.keyUsage ||
    certificate.keyUsage.some((usage) =>
      /digital\s*signature|non[- ]?repudiation|content\s*commitment|1\.3\.6\.1\.5\.5\.7\.3|2\.5\.29\.15/i.test(
        usage,
      ),
    );
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    validFrom > now ||
    validTo < now ||
    !keyUsageAllowed ||
    certificate.publicKey.asymmetricKeyType !== "rsa" ||
    (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw invalidCredential(
      "The DIAN signature trust anchor is not a valid RSA signing certificate.",
    );
  }
  return certificate;
}

const digestAlgorithms = new Map<string, "sha256" | "sha384" | "sha512">([
  ["http://www.w3.org/2001/04/xmlenc#sha256", "sha256"],
  ["http://www.w3.org/2001/04/xmldsig-more#sha384", "sha384"],
  ["http://www.w3.org/2001/04/xmlenc#sha512", "sha512"],
]);

function digestAlgorithm(uri: string): "sha256" | "sha384" | "sha512" {
  const algorithm = digestAlgorithms.get(uri);
  if (!algorithm) throw invalidDocument();
  return algorithm;
}

const signatureAlgorithms = new Map<string, "RSA-SHA256" | "RSA-SHA384" | "RSA-SHA512">([
  ["http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", "RSA-SHA256"],
  ["http://www.w3.org/2001/04/xmldsig-more#rsa-sha384", "RSA-SHA384"],
  ["http://www.w3.org/2001/04/xmldsig-more#rsa-sha512", "RSA-SHA512"],
]);

function signatureAlgorithm(uri: string): "RSA-SHA256" | "RSA-SHA384" | "RSA-SHA512" {
  const algorithm = signatureAlgorithms.get(uri);
  if (!algorithm) throw invalidDocument();
  return algorithm;
}

function verifyXmlDsig(
  root: XmlElement,
  signature: XmlElement,
  certificate: X509Certificate,
): void {
  assertOnlyElementChildren(signature, [
    ["SignedInfo", dsigNamespace],
    ["SignatureValue", dsigNamespace],
    ["KeyInfo", dsigNamespace],
  ]);
  const signedInfo = one(children(signature, "SignedInfo", dsigNamespace));
  const signatureValue = one(children(signature, "SignatureValue", dsigNamespace));
  const keyInfo = one(children(signature, "KeyInfo", dsigNamespace));
  assertNoElementChildren(signatureValue);
  assertOnlyElementChildren(keyInfo, [["X509Data", dsigNamespace]]);
  const x509Data = one(children(keyInfo, "X509Data", dsigNamespace));
  assertOnlyElementChildren(x509Data, [["X509Certificate", dsigNamespace]]);
  const x509CertElement = one(children(x509Data, "X509Certificate", dsigNamespace));
  assertNoElementChildren(x509CertElement);
  const embeddedCertificate = base64(text(x509CertElement));
  if (
    embeddedCertificate.length !== certificate.raw.length ||
    !timingSafeEqual(embeddedCertificate, certificate.raw)
  ) {
    throw invalidDocument();
  }
  assertOnlyElementChildren(signedInfo, [
    ["CanonicalizationMethod", dsigNamespace],
    ["SignatureMethod", dsigNamespace],
    ["Reference", dsigNamespace],
  ]);
  const canonicalization = one(children(signedInfo, "CanonicalizationMethod", dsigNamespace));
  assertNoElementChildren(canonicalization);
  const canonicalizationAlgorithm = attribute(canonicalization, "Algorithm");
  if (![c14nAlgorithm, exclusiveC14nAlgorithm].includes(canonicalizationAlgorithm)) {
    throw invalidDocument();
  }
  const signatureMethodElement = one(children(signedInfo, "SignatureMethod", dsigNamespace));
  assertNoElementChildren(signatureMethodElement);
  const signatureMethod = signatureAlgorithm(attribute(signatureMethodElement, "Algorithm"));
  const reference = one(children(signedInfo, "Reference", dsigNamespace));
  if (attribute(reference, "URI") !== "") throw invalidDocument();
  assertOnlyElementChildren(reference, [
    ["Transforms", dsigNamespace],
    ["DigestMethod", dsigNamespace],
    ["DigestValue", dsigNamespace],
  ]);
  const transforms = one(children(reference, "Transforms", dsigNamespace));
  assertOnlyElementChildren(transforms, [["Transform", dsigNamespace]]);
  const transform = one(children(transforms, "Transform", dsigNamespace));
  assertNoElementChildren(transform);
  if (attribute(transform, "Algorithm") !== envelopedTransform) throw invalidDocument();
  const digestMethodElement = one(children(reference, "DigestMethod", dsigNamespace));
  assertNoElementChildren(digestMethodElement);
  const digestMethod = digestAlgorithm(attribute(digestMethodElement, "Algorithm"));
  const digestValueElement = one(children(reference, "DigestValue", dsigNamespace));
  assertNoElementChildren(digestValueElement);
  const expectedDigest = base64(text(digestValueElement));
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

function optionalDirectText(
  element: XmlElement,
  localName: string,
  namespaceUri: string,
): string | null {
  const matches = children(element, localName, namespaceUri);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw invalidDocument();
  return text(matches[0]!);
}

function assertSignedPayloadParity(signedRoot: XmlElement, unsignedXml: string): void {
  let unsignedRoot: XmlElement;
  try {
    unsignedRoot = parseXml(unsignedXml);
  } catch {
    return;
  }
  if (unsignedRoot.localName !== signedRoot.localName) return;
  const expectedProfile = optionalDirectText(unsignedRoot, "ProfileExecutionID", cbcNamespace);
  if (expectedProfile !== null) {
    if (optionalDirectText(signedRoot, "ProfileExecutionID", cbcNamespace) !== expectedProfile) {
      throw invalidDocument();
    }
    const unsignedUuid = children(unsignedRoot, "UUID", cbcNamespace)[0];
    const signedUuid = children(signedRoot, "UUID", cbcNamespace)[0];
    if (unsignedUuid && signedUuid) {
      const expectedSchemeId = unsignedUuid.attributes.find(
        (attr) => attr.localName === "schemeID" && attr.namespaceUri === "",
      )?.value;
      if (expectedSchemeId && attribute(signedUuid, "schemeID") !== expectedSchemeId) {
        throw invalidDocument();
      }
    }
  }
  const unsignedSupplier = children(unsignedRoot, "AccountingSupplierParty", cacNamespace)[0];
  if (unsignedSupplier) {
    const signedSupplier = one(children(signedRoot, "AccountingSupplierParty", cacNamespace));
    const expectedNit = text(
      one(
        children(
          one(
            children(
              one(children(unsignedSupplier, "Party", cacNamespace)),
              "PartyIdentification",
              cacNamespace,
            ),
          ),
          "ID",
          cbcNamespace,
        ),
      ),
    );
    const actualNit = text(
      one(
        children(
          one(
            children(
              one(children(signedSupplier, "Party", cacNamespace)),
              "PartyIdentification",
              cacNamespace,
            ),
          ),
          "ID",
          cbcNamespace,
        ),
      ),
    );
    if (actualNit !== expectedNit) throw invalidDocument();
  }
  const unsignedMonetary = children(unsignedRoot, "LegalMonetaryTotal", cacNamespace)[0];
  if (unsignedMonetary) {
    const signedMonetary = one(children(signedRoot, "LegalMonetaryTotal", cacNamespace));
    const expectedPayable = text(one(children(unsignedMonetary, "PayableAmount", cbcNamespace)));
    const actualPayable = text(one(children(signedMonetary, "PayableAmount", cbcNamespace)));
    if (actualPayable !== expectedPayable) throw invalidDocument();
  }
  const unsignedTax = children(unsignedRoot, "TaxTotal", cacNamespace)[0];
  if (unsignedTax) {
    const signedTax = one(children(signedRoot, "TaxTotal", cacNamespace));
    const expectedTax = text(one(children(unsignedTax, "TaxAmount", cbcNamespace)));
    const actualTax = text(one(children(signedTax, "TaxAmount", cbcNamespace)));
    if (actualTax !== expectedTax) throw invalidDocument();
  }
  const unsignedBillingRef = children(unsignedRoot, "BillingReference", cacNamespace)[0];
  if (unsignedBillingRef) {
    const signedBillingRef = one(children(signedRoot, "BillingReference", cacNamespace));
    const expectedRefUuid = text(
      one(
        children(
          one(children(unsignedBillingRef, "InvoiceDocumentReference", cacNamespace)),
          "UUID",
          cbcNamespace,
        ),
      ),
    );
    const actualRefUuid = text(
      one(
        children(
          one(children(signedBillingRef, "InvoiceDocumentReference", cacNamespace)),
          "UUID",
          cbcNamespace,
        ),
      ),
    );
    if (actualRefUuid !== expectedRefUuid) throw invalidDocument();
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
          namespace: invoiceNamespace,
          scheme: "CUFE",
        },
        CREDIT_NOTE: {
          name: "CreditNote",
          namespace: creditNoteNamespace,
          scheme: "CUDE",
        },
      }[expected.documentType]
    : null;
  if (
    (expectedRoot &&
      (document.localName !== expectedRoot.name ||
        document.namespaceUri !== expectedRoot.namespace)) ||
    (!expectedRoot &&
      !(
        (document.localName === "Invoice" && document.namespaceUri === invoiceNamespace) ||
        (document.localName === "CreditNote" && document.namespaceUri === creditNoteNamespace)
      ))
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
  if (expected.unsignedXml) {
    assertSignedPayloadParity(document, expected.unsignedXml);
  }
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
