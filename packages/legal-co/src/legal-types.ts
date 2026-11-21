export interface LegalLink {
  readonly label: string;
  readonly href: string;
}

export interface LegalSection {
  readonly id: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
  readonly links?: readonly LegalLink[];
}

export interface LegalDocument {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly version: string;
  readonly effectiveDate: string;
  readonly sections: readonly LegalSection[];
}

export interface LegalOperator {
  readonly legalName: string;
  readonly tradeName: string;
  readonly countryCode: "CO";
  readonly siteUrl: string;
  readonly contactEmail: string;
  readonly privacyEmail: string;
}

export interface LegalConfiguration {
  readonly operator: LegalOperator;
  readonly documents: readonly LegalDocument[];
}

export const requiredLegalSlugs = [
  "terminos-y-condiciones",
  "privacidad",
  "tratamiento-datos-personales",
  "cookies",
  "retracto-y-devoluciones",
  "garantias",
  "envios-y-entregas",
  "pqrs",
] as const;

export type RequiredLegalSlug = (typeof requiredLegalSlugs)[number];
