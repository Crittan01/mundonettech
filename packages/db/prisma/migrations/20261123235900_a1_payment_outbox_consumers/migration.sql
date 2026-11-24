DELETE FROM "DomainOutbox"
WHERE "eventType" IN (
  'payment.attempt.created.v1',
  'payment.attempt.expired.v1',
  'payment.bank-transfer.confirmed.v1',
  'payment.cod.reconciled.v1',
  'payment.wompi.succeeded.v1',
  'store-credit.adjusted.v1'
);
