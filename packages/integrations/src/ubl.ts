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
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      !Number.isInteger(line.taxRateBps) ||
      line.taxRateBps < 0 ||
      line.taxRateBps > 10_000
    ) {
      throw new InvoiceValidationError("Fiscal line quantity or tax rate is invalid.");
    }
    money(line.unitPriceCents, "unitPriceCents");
    money(line.discountCents, "discountCents");
    money(line.lineTotalCents, "lineTotalCents");
    money(line.taxCents, "taxCents");
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

function lines(input: readonly FiscalLine[], shippingCents = 0n): string {
  const records: readonly FiscalLine[] =
    input.length === 0 && shippingCents > 0n
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
          },
        ]
      : input;
  return records
    .map((line, index) => {
      const rate = BigInt(line.taxRateBps);
      const percent = `${rate / 100n}.${(rate % 100n).toString().padStart(2, "0")}`;
      const discount =
        line.discountCents > 0n
          ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>1</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Descuento comercial</cbc:AllowanceChargeReason><cbc:Amount currencyID="COP">${money(line.discountCents, "discountCents")}</cbc:Amount></cac:AllowanceCharge>`
          : "";
      return `<cac:InvoiceLine><cbc:ID>${index + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="EA">${line.quantity}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="COP">${money(line.lineTotalCents, "lineTotalCents")}</cbc:LineExtensionAmount>${discount}<cac:TaxTotal><cbc:TaxAmount currencyID="COP">${money(line.taxCents, "taxCents")}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">${money(line.lineTotalCents, "lineTotalCents")}</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">${money(line.taxCents, "taxCents")}</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>${percent}</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:Item><cbc:Description>${xml(line.title, 200)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${xml(line.sku, 64)}</cbc:ID></cac:SellersItemIdentification></cac:Item><cac:Price><cbc:PriceAmount currencyID="COP">${money(line.unitPriceCents, "unitPriceCents")}</cbc:PriceAmount><cbc:BaseQuantity unitCode="EA">${line.quantity}</cbc:BaseQuantity></cac:Price></cac:InvoiceLine>`;
    })
    .join("");
}

function totals(input: InvoiceDocumentInput | CreditNoteDocumentInput): string {
  const discount =
    input.discountCents > 0n
      ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>1</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Descuentos del documento</cbc:AllowanceChargeReason><cbc:Amount currencyID="COP">${money(input.discountCents, "discountCents")}</cbc:Amount></cac:AllowanceCharge>`
      : "";
  const shipping =
    input.shippingCents > 0n
      ? `<cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>1</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Flete</cbc:AllowanceChargeReason><cbc:Amount currencyID="COP">${money(input.shippingCents, "shippingCents")}</cbc:Amount></cac:AllowanceCharge>`
      : "";
  return `${discount}${shipping}<cac:TaxTotal><cbc:TaxAmount currencyID="COP">${money(input.taxCents, "taxCents")}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="COP">${money(input.subtotalCents - input.discountCents, "taxableBaseCents")}</cbc:TaxableAmount><cbc:TaxAmount currencyID="COP">${money(input.taxCents, "taxCents")}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal><cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="COP">${money(usesShippingLine(input) ? input.shippingCents : input.subtotalCents - input.discountCents, "lineExtensionCents")}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="COP">${money(input.subtotalCents - input.discountCents + input.shippingCents, "taxExclusiveCents")}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="COP">${money(input.totalCents, "totalCents")}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="COP">${money(input.totalCents, "totalCents")}</cbc:PayableAmount></cac:LegalMonetaryTotal>`;
}

export function buildInvoiceUbl(input: InvoiceDocumentInput, production: boolean): string {
  validateDocument(input);
  const timestamp = dianTimestamp(input.issueDate);
  const creditLines = lines(input.lines, input.shippingCents).replaceAll(
    "InvoiceLine",
    "InvoiceLine",
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID><cbc:CustomizationID>DIAN 2.1</cbc:CustomizationID><cbc:ProfileID>DIAN 2.1: Factura electrónica de venta</cbc:ProfileID><cbc:ProfileExecutionID>${production ? "1" : "2"}</cbc:ProfileExecutionID><cbc:ID>${xml(input.fullNumber, 40)}</cbc:ID><cbc:UUID schemeID="${production ? "1" : "2"}" schemeName="CUFE">${xml(input.cufe, 96)}</cbc:UUID><cbc:IssueDate>${timestamp.date}</cbc:IssueDate><cbc:IssueTime>${timestamp.time}</cbc:IssueTime><cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>${usesShippingLine(input) ? 1 : input.lines.length}</cbc:LineCountNumeric>${party(input.issuer, true)}${party(input.buyer, false)}${totals(input)}${creditLines}</Invoice>`;
}

export function buildCreditNoteUbl(input: CreditNoteDocumentInput, production: boolean): string {
  validateDocument(input);
  if (!Number.isInteger(input.reasonCode) || input.reasonCode < 1 || input.reasonCode > 6)
    throw new InvoiceValidationError("Credit note reason code must be between 1 and 6.");
  const timestamp = dianTimestamp(input.issueDate);
  const creditLines = lines(input.lines, input.shippingCents)
    .replaceAll("InvoiceLine", "CreditNoteLine")
    .replaceAll("InvoicedQuantity", "CreditedQuantity");
  const reasons: Record<number, string> = {
    1: "Devolución parcial de bienes y/o servicios",
    2: "Anulación de factura electrónica",
    3: "Rebaja o descuento total",
    4: "Ajuste de precio",
    5: "Descuento comercial",
    6: "Otro",
  };
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID><cbc:CustomizationID>DIAN 2.1</cbc:CustomizationID><cbc:ProfileID>DIAN 2.1: Nota Crédito</cbc:ProfileID><cbc:ProfileExecutionID>${production ? "1" : "2"}</cbc:ProfileExecutionID><cbc:ID>${xml(input.fullNumber, 40)}</cbc:ID><cbc:UUID schemeID="${production ? "1" : "2"}" schemeName="CUDE">${xml(input.cude, 96)}</cbc:UUID><cbc:IssueDate>${timestamp.date}</cbc:IssueDate><cbc:IssueTime>${timestamp.time}</cbc:IssueTime><cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode><cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>${usesShippingLine(input) ? 1 : input.lines.length}</cbc:LineCountNumeric><cac:DiscrepancyResponse><cac:ReferenceID>${xml(input.invoiceFullNumber, 40)}</cac:ReferenceID><cbc:ResponseCode>${input.reasonCode}</cbc:ResponseCode><cbc:Description>${xml(reasons[input.reasonCode]!, 200)}</cbc:Description></cac:DiscrepancyResponse><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xml(input.invoiceFullNumber, 40)}</cbc:ID><cbc:UUID schemeName="CUFE">${xml(input.invoiceCufe, 96)}</cbc:UUID><cbc:IssueDate>${dianTimestamp(input.invoiceIssueDate).date}</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>${party(input.issuer, true)}${party(input.buyer, false)}${totals(input)}${creditLines}</CreditNote>`;
}
