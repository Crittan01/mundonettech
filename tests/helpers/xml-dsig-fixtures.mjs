import { execFileSync } from "node:child_process";
import { createHash, sign as signPayload } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const cbcNamespace = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const dsigNamespace = "http://www.w3.org/2000/09/xmldsig#";

export function createXmlDsigSigner(commonName) {
  const directory = mkdtempSync("tmp/xml-dsig-");
  const keyPath = join(directory, "key.pem");
  const certificatePath = join(directory, "certificate.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "3650",
        "-subj",
        `/CN=${commonName}`,
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      privateKey: readFileSync(keyPath, "utf8").trim(),
      certificate: readFileSync(certificatePath, "utf8").trim(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function signFiscalDocument(options) {
  const root = options.root ?? "Invoice";
  const number = options.number ?? (root === "Invoice" ? "FE1" : "NC1");
  const scheme = options.scheme ?? (root === "Invoice" ? "CUFE" : "CUDE");
  const hash =
    options.hash ??
    createHash("sha384").update(`${root}:${number}:${scheme}`, "utf8").digest("hex");
  const privateKey = options.privateKey;
  const certificate = options.certificate;
  if (!privateKey || !certificate)
    throw new TypeError("A test signing key and certificate are required.");
  const rootNamespace =
    root === "Invoice"
      ? "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
      : "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
  const cacNamespace =
    options.nestedIdentity || options.extraChildren
      ? ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"'
      : "";
  const namespaceText = `xmlns="${rootNamespace}"${cacNamespace} xmlns:cbc="${cbcNamespace}" xmlns:ds="${dsigNamespace}"`;
  const subsetNamespaces = options.exclusiveC14n ? `xmlns:ds="${dsigNamespace}"` : namespaceText;
  const canonicalizationAlgorithm = options.exclusiveC14n
    ? "http://www.w3.org/2001/10/xml-exc-c14n#"
    : "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  const schemeIdAttr = options.schemeId ? ` schemeID="${options.schemeId}"` : "";
  const identity = `<cbc:ID>${number}</cbc:ID><cbc:UUID${schemeIdAttr}${options.schemeOnRoot ? "" : ` schemeName="${scheme}"`}>${hash}</cbc:UUID>${options.extraChildren ?? ""}`;
  const rootAttributes = `${namespaceText}${options.schemeOnRoot ? ` schemeName="${scheme}"` : ""}`;
  const documentWithoutSignature = `<${root} ${rootAttributes}>${options.nestedIdentity ? `<cac:Wrapper>${identity}</cac:Wrapper>` : identity}</${root}>`;
  const digest = createHash("sha256").update(documentWithoutSignature, "utf8").digest("base64");
  const signedInfo = `<ds:SignedInfo ${subsetNamespaces}><ds:CanonicalizationMethod Algorithm="${canonicalizationAlgorithm}"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod><ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const signatureValue = signPayload("RSA-SHA256", Buffer.from(signedInfo), privateKey).toString(
    "base64",
  );
  const certificateValue = certificate
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\s+/g, "");
  const signature = `<ds:Signature>${signedInfo}<ds:SignatureValue>${signatureValue}</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificateValue}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>`;
  return {
    xml: `<${root} ${rootAttributes}>${options.nestedIdentity ? `<cac:Wrapper>${identity}</cac:Wrapper>` : identity}${signature}</${root}>`,
    hash,
    number,
  };
}
