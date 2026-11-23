import "server-only";

import {
  LifecycleService,
  RfmAnalyticsService,
  SegmentationService,
  type PrismaClient,
} from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

export function lifecycleService(db: PrismaClient = getDatabase()): LifecycleService {
  return new LifecycleService(db);
}

export function segmentationService(db: PrismaClient = getDatabase()): SegmentationService {
  return new SegmentationService(db);
}

export function rfmAnalyticsService(db: PrismaClient = getDatabase()): RfmAnalyticsService {
  return new RfmAnalyticsService(db);
}
