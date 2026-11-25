import { escapeXml } from "@mundonettech/core";

import { dianTimestamp } from "./dian.js";
import { centsToDecimal } from "./integration-utils.js";
import {
  InvoiceValidationError,
  type CreditNoteDocumentInput,
  type FiscalLine,
  type FiscalParty,
  type InvoiceDocumentInput,
} from "./invoice-types.js";

function money(value: bigint, field: string, allowZero = true): string {
  if (typeof value !== "bigint" || value < (allowZero ? 0n : 1n))
    throw new InvoiceValidationError(
      `${field} must be ${allowZero ? "non-negative" : "positive"} integer cents.`,
    );
  return centsToDecimal(value);
}

function xml(value: string, maximum = 500): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new InvoiceValidationError(
      "UBL text contains invalid characters or exceeds its field limit.",
    );
  }
  return escapeXml(value);
}

function party(party: FiscalParty, issuer: boolean): string {
  const legalName = xml(party.legalName, 200);
  const companyId = xml(party.documentNumber, 30);
  const scheme = xml(party.documentType, 2);
  const postal = party.postalCode
    ? `<cbc:PostalZone>${xml(party.postalCode, 6)}</cbc:PostalZone>`
    : "";
  if (!issuer && !party.taxRegime)
    throw new InvoiceValidationError("Buyer tax regime is required.");
  const taxLevel =
    issuer || party.taxRegime === "RESPONSABLE_IVA"
      ? `<cbc:TaxLevelCode listName="R-00-PN">R-00-PN</cbc:TaxLevelCode>`
      : `<cbc:TaxLevelCode listName="R-99-PN">R-99-PN</cbc:TaxLevelCode>`;
  return `<cac:${issuer ? "AccountingSupplierParty" : "AccountingCustomerParty"}><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${scheme}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${companyId}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${legalName}</cbc:Name></cac:PartyName><cac:PhysicalLocation><cac:Address><cbc:ID>${xml(party.municipalityCode, 5)}</cbc:ID><cbc:CityName>${xml(party.municipalityName, 120)}</cbc:CityName>${postal}<cbc:CountrySubentity>${xml(party.departmentName, 120)}</cbc:CountrySubentity><cbc:CountrySubentityCode>${xml(party.departmentCode, 2)}</cbc:CountrySubentityCode><cac:AddressLine><cbc:Line>${xml(party.addressLine1, 200)}</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>CO</cbc:IdentificationCode></cac:Country></cac:Address></cac:PhysicalLocation><cac:PartyTaxScheme><cbc:RegistrationName>${legalName}</cbc:RegistrationName><cbc:CompanyID schemeID="${scheme}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${companyId}</cbc:CompanyID>${taxLevel}<cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${legalName}</cbc:RegistrationName><cbc:CompanyID schemeID="${scheme}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${companyId}</cbc:CompanyID></cac:PartyLegalEntity><cac:Contact><cbc:ElectronicMail>${xml(party.email, 320)}</cbc:ElectronicMail><cbc:Telephone>${xml(party.phoneE164, 16)}</cbc:Telephone></cac:Contact></cac:Party></cac:${issuer ? "AccountingSupplierParty" : "AccountingCustomerParty"}>`;
}

function usesShippingLine(input: InvoiceDocumentInput | CreditNoteDocumentInput): boolean {
  return input.lines.length === 0 && input.shippingCents > 0n;
}

function validateDocument(input: InvoiceDocumentInput | CreditNoteDocumentInput): void {
  if (!Array.isArray(input.lines) || input.lines.length > 10_000)
    throw new InvoiceValidationError("Fiscal documents require at most 10000 lines.");
  if (input.lines.length === 0 && input.shippingCents <= 0n) {
    throw new InvoiceValidationError(
      "A document without product lines requires a shipping charge.",
    );
  }
  let net = 0n;
  let tax = 0n;
  for (const line of input.lines) {
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      !Number.isSafeInteger(line.taxRateBps) ||
      line.taxRateBps < 0 ||
      line.taxRateBps > 10_000
    ) {
      throw new InvoiceValidationError("Fiscal line quantity or tax rate is invalid.");
    }
    money(line.unitPriceCents, "unitPriceCents");
    money(line.discountCents, "discountCents");
    money(line.lineTotalCents, "lineTotalCents");
    money(line.taxCents, "taxCents");
    if (
      (line.taxCategory === "EXEMPT" || line.taxCategory === "EXCLUDED") &&
      (line.taxRateBps !== 0 || line.taxCents !== 0n)
    ) {
      throw new InvoiceValidationError("Exempt or excluded fiscal lines must carry 0% tax.");
    }
    if (line.unitPriceCents * BigInt(line.quantity) - line.discountCents !== line.lineTotalCents)
      throw new InvoiceValidationError("Fiscal line discount does not balance its net amount.");
    net += line.lineTotalCents;
    tax += line.taxCents;
  }
  const expectedNet = input.subtotalCents - input.discountCents;
  if (net !== expectedNet || tax !== input.taxCents)
    throw new InvoiceValidationError(
      "Fiscal lines do not balance document subtotal, discount and taxes.",
    );
  if (
    input.totalCents !==
    input.subtotalCents - input.discountCents + input.taxCents + input.shippingCents
  )
    throw new InvoiceValidationError("Fiscal document total does not balance.");
}

function resolutionDate(value: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    throw new InvoiceValidationError("DIAN resolution dates must use YYYY-MM-DD.");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvoiceValidationError("DIAN resolution dates must be valid calendar dates.");
  }
  return value;
}

function invoiceControl(input: InvoiceDocumentInput): string {
  const resolution = input.resolution;
  if (!resolution || typeof resolution !== "object") {
    throw new InvoiceValidationError("DIAN invoice resolution is required.");
  }
  const validFrom = resolutionDate(resolution.validFrom);
  const validTo = resolutionDate(resolution.validTo);
  const prefix = xml(resolution.prefix, 20);
  const suffix = input.fullNumber.startsWith(resolution.prefix)
    ? input.fullNumber.slice(resolution.prefix.length)
    : "";
  const number = Number(suffix);
  if (
    validTo < validFrom ||
    !Number.isSafeInteger(resolution.rangeStart) ||
    !Number.isSafeInteger(resolution.rangeEnd) ||
    resolution.rangeStart < 1 ||
    resolution.rangeEnd < resolution.rangeStart ||
    !/^[0-9]+$/.test(suffix) ||
    !Number.isSafeInteger(number) ||
    number < resolution.rangeStart ||
    number > resolution.rangeEnd ||
    dianTimestamp(input.issueDate).date < validFrom ||
    dianTimestamp(input.issueDate).date > validTo
  ) {
    throw new InvoiceValidationError(
      "Invoice number or issue date is outside its DIAN resolution.",
    );
  }
  return `<sts:DianExtensions><sts:InvoiceControl><cbc:InvoiceAuthorization>${xml(resolution.authorizationNumber, 40)}</cbc:InvoiceAuthorization><sts:AuthorizationPeriod><cbc:StartDate>${validFrom}</cbc:StartDate><cbc:EndDate>${validTo}</cbc:EndDate></sts:AuthorizationPeriod><sts:AuthorizedInvoice><cbc:Prefix>${prefix}</cbc:Prefix><cbc:From>${resolution.rangeStart}</cbc:From><cbc:To>${resolution.rangeEnd}</cbc:To></sts:AuthorizedInvoice></sts:InvoiceControl></sts:DianExtensions>`;
}

type TaxCategory = NonNullable<FiscalLine["taxCategory"]>;

function fiscalLines(input: readonly FiscalLine[], shippingCents: bigint): readonly FiscalLine[] {
  return input.length === 0 && shippingCents > 0n
    ? [
        {
          sku: "FLETE",
          title: "Flete",
          quantity: 1,
          unitPriceCents: shippingCents,
          discountCents: 0n,
          lineTotalCents: shippingCents,
          taxCents: 0n,
          taxRateBps: 0,
          taxCategory: "EXCLUDED",
        },
      ]
    : input;
}

function percent(rateBps: number): string {
  const rate = BigInt(rateBps);
  return `${rate / 100n}.${(rate % 100n).toString().padStart(2, "0")}`;
}

const taxCategoryCodes = new Map<TaxCategory, string>([
  ["STANDARD", "S"],
  ["EXEMPT", "E"],
  ["EXCLUDED", "O"],
]);

function taxCategory(line: Pick<FiscalLine, "taxCategory" | "taxRateBps">): string {
  const category = line.taxCategory ?? "STANDARD";
  const code = taxCategoryCodes.get(category);
  if (!code) throw new InvoiceValidationError("Fiscal tax category is invalid.");
  return `<cac:TaxCategory><cbc:ID>${code}</cbc:ID><cbc:Percent>${percent(line.taxRateBps)}</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:TaxCategory>`;
}

function lines(
  input: readonly FiscalLine[],
  shippingCents = 0n,
  kind: "invoice" | "credit-note" = "invoice",
): string {
  const lineTag = kind === "credit-note" ? "CreditNoteLine" : "InvoiceLine";
  const quantityTag = kind === "credit-note" ? "CreditedQuantity" : "InvoicedQuantity";
  return fiscalLines(input, shippingCents)
    .map((line, index) => {
      const discount =
        line.discountCents > 0n
          ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>1</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Descuento comercial</cbc:AllowanceChargeReason><cbc:Amount currencyID="COP">${money(line.discountCents, "discountCents")}</cbc:Amount></cac:AllowanceCharge>`
          : "";
      return `<cac:${lineTag}><cbc:ID>${index + 1}</cbc:ID><cbc:${quantityTag} unitCode="EA">${line.quantity}</cbc:${quantityTag}><cbc:LineExtensionAmount currencyID="COP">${money(line.lineTotalCents, "lineTotalCents")}</cbc:LineExtensionAmount>${discount}<cac:TaxTotal><cbc:TaxAmount currencyID="COP">${money(line.taxCents, "taxCents")}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">${money(line.lineTotalCents, "lineTotalCents")}</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">${money(line.taxCents, "taxCents")}</cbc:TaxAmount>${taxCategory(line)}</cac:TaxSubtotal></cac:TaxTotal><cac:Item><cbc:Description>${xml(line.title, 200)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${xml(line.sku, 64)}</cbc:ID></cac:SellersItemIdentification></cac:Item><cac:Price><cbc:PriceAmount currencyID="COP">${money(line.unitPriceCents, "unitPriceCents")}</cbc:PriceAmount><cbc:BaseQuantity unitCode="EA">1</cbc:BaseQuantity></cac:Price></cac:${lineTag}>`;
    })
    .join("");
}

function taxSubtotals(input: InvoiceDocumentInput | CreditNoteDocumentInput): string {
  const groups = new Map<
    string,
    { category: TaxCategory; rateBps: number; taxableCents: bigint; taxCents: bigint }
  >();
  for (const line of fiscalLines(input.lines, input.shippingCents)) {
    const category = line.taxCategory ?? "STANDARD";
    const key = `${category}:${line.taxRateBps}`;
    const group = groups.get(key) ?? {
      category,
      rateBps: line.taxRateBps,
      taxableCents: 0n,
      taxCents: 0n,
    };
    group.taxableCents += line.lineTotalCents;
    group.taxCents += line.taxCents;
    groups.set(key, group);
  }
  let taxableCents = 0n;
  let taxCents = 0n;
  const subtotals = [...groups.values()]
    .sort((left, right) =>
      left.category === right.category
        ? left.rateBps - right.rateBps
        : left.category < right.category
          ? -1
          : 1,
    )
    .map((group) => {
      taxableCents += group.taxableCents;
      taxCents += group.taxCents;
      return `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">${money(group.taxableCents, "groupTaxableCents")}</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">${money(group.taxCents, "groupTaxCents")}</cbc:TaxAmount>${taxCategory({ taxCategory: group.category, taxRateBps: group.rateBps })}</cac:TaxSubtotal>`;
    })
    .join("");
  const expectedTaxable = usesShippingLine(input)
    ? input.shippingCents
    : input.subtotalCents - input.discountCents;
  if (taxableCents !== expectedTaxable || taxCents !== input.taxCents) {
    throw new InvoiceValidationError("Grouped fiscal taxes do not balance the document.");
  }
  return subtotals;
}

function totals(input: InvoiceDocumentInput | CreditNoteDocumentInput): string {
  const hasDocumentShippingCharge = input.shippingCents > 0n && !usesShippingLine(input);
  const shipping = hasDocumentShippingCharge
    ? `<cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>1</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Flete</cbc:AllowanceChargeReason><cbc:Amount currencyID="COP">${money(input.shippingCents, "shippingCents")}</cbc:Amount></cac:AllowanceCharge>`
    : "";
  const chargeTotal = hasDocumentShippingCharge
    ? `<cbc:ChargeTotalAmount currencyID="COP">${money(input.shippingCents, "shippingCents")}</cbc:ChargeTotalAmount>`
    : "";
  const lineExtensionCents = usesShippingLine(input)
    ? input.shippingCents
    : input.subtotalCents - input.discountCents;
  return `${shipping}<cac:TaxTotal><cbc:TaxAmount currencyID="COP">${money(input.taxCents, "taxCents")}</cbc:TaxAmount>${taxSubtotals(input)}</cac:TaxTotal><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="COP">${money(lineExtensionCents, "lineExtensionCents")}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="COP">${money(lineExtensionCents, "taxExclusiveCents")}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="COP">${money(lineExtensionCents + input.taxCents, "taxInclusiveCents")}</cbc:TaxInclusiveAmount>${chargeTotal}<cbc:PayableAmount currencyID="COP">${money(input.totalCents, "totalCents")}</cbc:PayableAmount></cac:LegalMonetaryTotal>`;
}

export function buildInvoiceUbl(input: InvoiceDocumentInput, production: boolean): string {
  validateDocument(input);
  const timestamp = dianTimestamp(input.issueDate);
  const control = invoiceControl(input);
  const invoiceLines = lines(input.lines, input.shippingCents);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="http://www.dian.gov.co/facturaelectronica/Structures-2-1"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>${control}</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID><cbc:CustomizationID>DIAN 2.1</cbc:CustomizationID><cbc:ProfileID>DIAN 2.1: Factura electrónica de venta</cbc:ProfileID><cbc:ProfileExecutionID>${production ? "1" : "2"}</cbc:ProfileExecutionID><cbc:ID>${xml(input.fullNumber, 40)}</cbc:ID><cbc:UUID schemeID="${production ? "1" : "2"}" schemeName="CUFE">${xml(input.cufe, 96)}</cbc:UUID><cbc:IssueDate>${timestamp.date}</cbc:IssueDate><cbc:IssueTime>${timestamp.time}</cbc:IssueTime><cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>${usesShippingLine(input) ? 1 : input.lines.length}</cbc:LineCountNumeric>${party(input.issuer, true)}${party(input.buyer, false)}${totals(input)}${invoiceLines}</Invoice>`;
}

export function buildCreditNoteUbl(input: CreditNoteDocumentInput, production: boolean): string {
  validateDocument(input);
  if (!Number.isInteger(input.reasonCode) || input.reasonCode < 1 || input.reasonCode > 6)
    throw new InvoiceValidationError("Credit note reason code must be between 1 and 6.");
  const timestamp = dianTimestamp(input.issueDate);
  const creditLines = lines(input.lines, input.shippingCents, "credit-note");
  const reasons: Record<number, string> = {
    1: "Devolución parcial de bienes y/o servicios",
    2: "Anulación de factura electrónica",
    3: "Rebaja o descuento total",
    4: "Ajuste de precio",
    5: "Descuento comercial",
    6: "Otro",
  };
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID><cbc:CustomizationID>DIAN 2.1</cbc:CustomizationID><cbc:ProfileID>DIAN 2.1: Nota Crédito</cbc:ProfileID><cbc:ProfileExecutionID>${production ? "1" : "2"}</cbc:ProfileExecutionID><cbc:ID>${xml(input.fullNumber, 40)}</cbc:ID><cbc:UUID schemeID="${production ? "1" : "2"}" schemeName="CUDE">${xml(input.cude, 96)}</cbc:UUID><cbc:IssueDate>${timestamp.date}</cbc:IssueDate><cbc:IssueTime>${timestamp.time}</cbc:IssueTime><cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode><cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>${usesShippingLine(input) ? 1 : input.lines.length}</cbc:LineCountNumeric><cac:DiscrepancyResponse><cbc:ReferenceID>${xml(input.invoiceFullNumber, 40)}</cbc:ReferenceID><cbc:ResponseCode>${input.reasonCode}</cbc:ResponseCode><cbc:Description>${xml(reasons[input.reasonCode]!, 200)}</cbc:Description></cac:DiscrepancyResponse><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xml(input.invoiceFullNumber, 40)}</cbc:ID><cbc:UUID schemeName="CUFE">${xml(input.invoiceCufe, 96)}</cbc:UUID><cbc:IssueDate>${dianTimestamp(input.invoiceIssueDate).date}</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>${party(input.issuer, true)}${party(input.buyer, false)}${totals(input)}${creditLines}</CreditNote>`;
}
