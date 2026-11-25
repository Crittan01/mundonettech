export interface XmlDsigSigner {
  readonly privateKey: string;
  readonly certificate: string;
}

export function createXmlDsigSigner(commonName: string): XmlDsigSigner;

export interface SignedFiscalDocument {
  readonly xml: string;
  readonly hash: string;
  readonly number: string;
}

export function signFiscalDocument(options: {
  readonly root?: "Invoice" | "CreditNote";
  readonly number?: string;
  readonly scheme?: "CUFE" | "CUDE";
  readonly hash?: string;
  readonly nestedIdentity?: boolean;
  readonly schemeOnRoot?: boolean;
  readonly exclusiveC14n?: boolean;
  readonly privateKey: string;
  readonly certificate: string;
}): SignedFiscalDocument;
