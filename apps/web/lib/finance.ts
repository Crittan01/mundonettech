import "server-only";

import { storeConfig } from "@mundonettech/config/store";
import { FinanceService } from "@mundonettech/db";

import { getDatabase } from "@/lib/db";

export function financeService(): FinanceService {
  return new FinanceService(getDatabase(), {
    uvtValueCents: BigInt(storeConfig.tax.uvtValueCents),
    uvtYear: storeConfig.tax.uvtYear,
    thresholdUvt: storeConfig.tax.annualRevenueAlertUvt,
  });
}
