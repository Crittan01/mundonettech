import type { createDatabaseClient } from "../../packages/db/dist/index.js";

export interface PublicReviewFixtureInput {
  readonly customerId: string;
  readonly moderatedByAdminUserId: string;
  readonly productSlug: string;
  readonly reviews: readonly {
    readonly authorDisplayName: string;
    readonly title: string;
    readonly createdAt: Date;
    readonly body?: string;
    readonly rating?: number;
  }[];
}

export function createPublishedReviewFixtures(
  db: ReturnType<typeof createDatabaseClient>,
  options: PublicReviewFixtureInput,
): Promise<{ orderId: string; productSlug: string; reviewIds: string[] }>;
