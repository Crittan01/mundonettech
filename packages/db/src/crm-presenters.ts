import { maskEmail, maskIdentifier, maskName, maskPhone } from "@mundonettech/core";

import type { Contact, ContactIdentity, Organization } from "./generated/client.js";

export function maskCrmOrganization(organization: Organization | null) {
  if (!organization) return null;
  return {
    id: organization.id,
    legalName: organization.legalName,
    commercialName: organization.commercialName,
    taxId: maskIdentifier(organization.taxId),
    priceListId: organization.priceListId,
    version: organization.version,
    createdAt: organization.createdAt,
    updatedAt: organization.updatedAt,
    deletedAt: organization.deletedAt,
  };
}

export function maskCrmIdentity(identity: ContactIdentity) {
  return {
    id: identity.id,
    contactId: identity.contactId,
    kind: identity.kind,
    normalizedValue:
      identity.kind === "EMAIL"
        ? maskEmail(identity.normalizedValue)
        : identity.kind === "PHONE"
          ? maskPhone(identity.normalizedValue)
          : maskIdentifier(identity.normalizedValue),
    verifiedAt: identity.verifiedAt,
    createdAt: identity.createdAt,
    retiredAt: identity.retiredAt,
  };
}

export function maskCrmContact(
  contact: Contact & {
    readonly organization?: Organization | null;
    readonly identities?: ContactIdentity[];
  },
) {
  return {
    id: contact.id,
    organizationId: contact.organizationId,
    customerId: contact.customerId,
    givenName: maskName(contact.givenName),
    familyName: maskName(contact.familyName),
    email: maskEmail(contact.email),
    phoneE164: maskPhone(contact.phoneE164),
    status: contact.status,
    verificationLevel: contact.verificationLevel,
    source: contact.source,
    retentionReviewAt: contact.retentionReviewAt,
    lastActivityAt: contact.lastActivityAt,
    mergedIntoContactId: contact.mergedIntoContactId,
    suppressionReason: contact.suppressionReason,
    suppressedAt: contact.suppressedAt,
    anonymizedAt: contact.anonymizedAt,
    version: contact.version,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
    deletedAt: contact.deletedAt,
    ...(contact.organization !== undefined
      ? { organization: maskCrmOrganization(contact.organization) }
      : {}),
    ...(contact.identities ? { identities: contact.identities.map(maskCrmIdentity) } : {}),
  };
}
