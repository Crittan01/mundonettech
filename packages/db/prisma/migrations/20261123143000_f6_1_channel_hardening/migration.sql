CREATE UNIQUE INDEX "ChannelOAuthAttempt_one_active_per_account_key"
  ON "ChannelOAuthAttempt"("accountId")
  WHERE "accountId" IS NOT NULL AND "status" IN ('PENDING', 'PROCESSING');
