import { randomBytes, randomUUID } from "node:crypto";

export const crmTables = [
  "Organization",
  "Contact",
  "ContactIdentity",
  "IdentityMergeCandidate",
  "ContactActivity",
  "Task",
];

export async function seedCrmFixture(client, { adminId }) {
  const organizationId = randomUUID();
  const sourceContactId = randomUUID();
  const targetContactId = randomUUID();
  const identityId = randomUUID();
  const candidateId = randomUUID();
  const activityId = randomUUID();
  const taskId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const email = `rls-crm-${suffix}@example.test`;
  await client.query(
    `INSERT INTO "Organization" ("id", "legalName", "commercialName", "taxId")
     VALUES ($1, $2, $3, $4)`,
    [
      organizationId,
      `Organización RLS ${suffix}`,
      `CRM ${suffix}`,
      `901${suffix.replaceAll("-", "").toUpperCase()}`,
    ],
  );
  for (const [index, contactId] of [sourceContactId, targetContactId].entries()) {
    await client.query(
      `INSERT INTO "Contact" ("id", "organizationId", "givenName", "familyName", "email", "phoneE164", "source", "retentionReviewAt")
       VALUES ($1, $2, $3, 'Contacto RLS', $4, $5, 'rls-matrix', CURRENT_TIMESTAMP + INTERVAL '24 months')`,
      [
        contactId,
        organizationId,
        `Identidad ${index + 1}`,
        email,
        `+5730012345${String(index).padStart(2, "0")}`,
      ],
    );
  }
  await client.query(
    `INSERT INTO "ContactIdentity" ("id", "contactId", "kind", "normalizedValue", "valueHash")
     VALUES ($1, $2, 'EMAIL', $3, $4)`,
    [identityId, sourceContactId, email, randomBytes(32)],
  );
  const pairKey = [sourceContactId, targetContactId].sort().join(":");
  await client.query(
    `INSERT INTO "IdentityMergeCandidate" ("id", "pairKey", "sourceContactId", "targetContactId", "matchScore", "matchReasons")
     VALUES ($1, $2, $3, $4, 10000, '["EMAIL_EXACT"]'::jsonb)`,
    [candidateId, pairKey, sourceContactId, targetContactId],
  );
  await client.query(
    `INSERT INTO "ContactActivity" ("id", "contactId", "kind", "subject", "body", "occurredAt", "createdByAdminUserId")
     VALUES ($1, $2, 'NOTE', 'Seguimiento RLS', 'Actividad persistida para la matriz de seguridad.', CURRENT_TIMESTAMP, $3)`,
    [activityId, sourceContactId, adminId],
  );
  await client.query(
    `INSERT INTO "Task" ("id", "contactId", "title", "description", "priority", "dueAt", "assignedToAdminUserId", "createdByAdminUserId")
     VALUES ($1, $2, 'Revisar identidad RLS', 'Validar los datos antes de continuar.', 'HIGH', CURRENT_TIMESTAMP + INTERVAL '2 days', $3, $3)`,
    [taskId, sourceContactId, adminId],
  );
  return {
    organizationId,
    sourceContactId,
    targetContactId,
    identityId,
    candidateId,
    activityId,
    taskId,
  };
}
