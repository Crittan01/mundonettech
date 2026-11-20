export { createDatabaseClient } from "./client.js";
export type { DatabaseClientOptions } from "./client.js";
export {
  AdminRole,
  AdminUserStatus,
  ConsentPurpose,
  ConsentStatus,
  CustomerStatus,
  IdempotencyStatus,
  IntegrationEnvironment,
  Prisma,
  PrismaClient,
} from "./generated/client.js";
export type {
  AdminActionLog,
  AdminRecoveryCode,
  AdminUser,
  Consent,
  Customer,
  DomainOutbox,
  IdempotencyKey,
  IntegrationCredential,
  SecurityEvent,
} from "./generated/client.js";
export { verifySecurityPosture } from "./verify-security-posture.js";
