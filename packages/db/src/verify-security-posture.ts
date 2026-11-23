import { pathToFileURL } from "node:url";

import pg from "pg";

const requiredTables = [
  "AdminUser",
  "AdminRecoveryCode",
  "AdminActionLog",
  "SecurityEvent",
  "Notification",
  "NotificationRead",
  "DailyFunnelMetric",
  "FiscalWatchSnapshot",
  "BackupRun",
  "DisasterRecoveryDrill",
  "RecoveryBucketCheck",
  "OperationalHealthSnapshot",
  "ChannelAccount",
  "ChannelOAuthAttempt",
  "ChannelListing",
  "ChannelOffer",
  "ChannelSyncJob",
  "Customer",
  "Consent",
  "Organization",
  "Contact",
  "ContactIdentity",
  "IdentityMergeCandidate",
  "ContactActivity",
  "Task",
  "IntegrationCredential",
  "DomainOutbox",
  "IdempotencyKey",
  "TaxGroup",
  "Brand",
  "Category",
  "Collection",
  "CollectionProduct",
  "Product",
  "OptionDefinition",
  "OptionValue",
  "ProductVariant",
  "ProductVariantOption",
  "ProductMedia",
  "AttributeDefinition",
  "CategoryAttribute",
  "ProductAttributeValue",
  "CompatibilityDevice",
  "ProductCompatibility",
  "Bundle",
  "BundleItem",
  "WishlistItem",
  "BackInStockSubscription",
  "UrlRedirect",
  "StockLocation",
  "StockLevel",
  "SerializedUnit",
  "InventoryLedger",
  "Supplier",
  "PurchaseOrder",
  "PurchaseOrderItem",
  "Order",
  "StoreSettings",
  "CmsPage",
  "CmsSectionBlock",
  "CmsBlockVersion",
  "CmsMedia",
  "WholesaleTier",
  "Coupon",
  "CouponProduct",
  "CouponCategory",
  "Cart",
  "CartItem",
  "CouponUsage",
  "OrderItem",
  "OrderItemTaxLine",
  "OrderItemReservation",
  "OrderReceipt",
  "OrderStatusEvent",
  "AbandonedCart",
  "OrderNumberSequence",
  "DaneDepartment",
  "DaneMunicipality",
  "Shipment",
  "ShipmentItem",
  "OrderRefund",
  "OrderRefundItem",
  "PaymentAttempt",
  "PaymentTransaction",
  "PaymentWebhookEvent",
  "BlockedIdentity",
  "RemittanceBatch",
  "CodReconciliation",
  "StoreCreditAccount",
  "StoreCreditEntry",
  "LocalDeliveryZone",
  "OrderFulfillment",
  "ShipmentPackage",
  "ShipmentPackageItem",
  "ShipmentEvent",
  "EmailTemplateOverride",
  "EmailEvent",
  "EmailSuppression",
  "EmailWebhookEvent",
  "TaxInvoice",
  "CreditNote",
  "Address",
  "GuestOrderChallenge",
  "GuestOrderSession",
  "ReturnRequest",
  "ReturnRequestItem",
  "ReturnRequestUnit",
  "WarrantyClaim",
  "SupportTicket",
  "SupportTicketMessage",
  "Review",
  "PriceList",
  "PriceListItem",
  "Opportunity",
  "OpportunityProposal",
  "OpportunityProposalItem",
  "OpportunityCopilotRun",
  "ReferralCode",
  "Referral",
  "LoyaltyTxn",
  "CustomerSegment",
  "CustomerSegmentMembership",
  "LifecycleJourney",
  "LifecycleStep",
  "LifecycleEnrollment",
  "LifecycleMessage",
] as const;
const dataApiRoles = ["anon", "authenticated", "service_role"] as const;
const nonBypassRoles = ["anon", "authenticated"] as const;
const requiredConstraints = [
  "AdminRecoveryCode_codeHash_length",
  "AdminActionLog_metadata_object",
  "Customer_loyaltyPoints_nonnegative",
  "Consent_revocation_consistent",
  "IntegrationCredential_nonce_length",
  "IntegrationCredential_ciphertext_length",
  "IntegrationCredential_authTag_length",
  "DomainOutbox_claim_consistent",
  "IdempotencyKey_requestHash_length",
  "SecurityEvent_dedupMinute_matches",
  "TaxGroup_rateBps_valid",
  "TaxGroup_uvt_treatment_valid",
  "ProductVariant_price_nonnegative",
  "ProductVariant_cost_nonnegative",
  "ProductVariant_compare_order",
  "ProductMedia_variantId_productId_fkey",
  "ProductMedia_focal_valid",
  "ProductMedia_frames_valid",
  "ProductMedia_posterKey_not_blank",
  "ProductMedia_mime_valid",
  "ProductMedia_usdzKey_valid",
  "ProductMedia_keys_safe",
  "ProductAttributeValue_exactly_one",
  "Bundle_price_nonnegative",
  "Bundle_discount_nonnegative",
  "Bundle_discount_valid",
  "BackInStockSubscription_status_timestamps",
  "UrlRedirect_status_valid",
  "StockLevel_committed_within_onHand",
  "StockLevel_safetyStock_nonnegative",
  "StockLevel_weightedAvgCost_nonnegative",
  "SerializedUnit_status_consistent",
  "InventoryLedger_operationHash_length",
  "InventoryLedger_movement_valid",
  "PurchaseOrderItem_unitCost_nonnegative",
  "PurchaseOrderItem_quantityReceived_valid",
  "PurchaseOrder_status_timestamps",
  "Order_total_balanced",
  "StoreSettings_key_valid",
  "StoreSettings_revenue_threshold_positive",
  "StoreSettings_currency_valid",
  "StoreSettings_timeZone_valid",
  "StoreSettings_order_prefix_valid",
  "StoreSettings_order_padding_valid",
  "CmsPage_slug_valid",
  "CmsPage_title_not_blank",
  "CmsPage_seo_not_blank",
  "CmsPage_publication_consistent",
  "CmsSectionBlock_type_valid",
  "CmsSectionBlock_position_nonnegative",
  "CmsBlockVersion_version_positive",
  "CmsBlockVersion_content_object",
  "CmsBlockVersion_publication_consistent",
  "CmsBlockVersion_contentHash_length",
  "CmsMedia_storageKey_safe",
  "CmsMedia_contentHash_length",
  "CmsMedia_filename_not_blank",
  "CmsMedia_mime_valid",
  "CmsMedia_alt_not_blank",
  "CmsMedia_byteSize_positive",
  "CmsMedia_dimensions_valid",
  "CmsMedia_derivatives_array",
  "WholesaleTier_scope_target_valid",
  "WholesaleTier_minimumQuantity_positive",
  "WholesaleTier_unitPrice_nonnegative",
  "Coupon_code_valid",
  "Coupon_name_not_blank",
  "Coupon_discount_value_valid",
  "Coupon_maximumDiscount_nonnegative",
  "Coupon_minimumSubtotal_nonnegative",
  "Coupon_schedule_valid",
  "Coupon_usage_limits_valid",
  "Cart_accessTokenHash_length",
  "Cart_assistedTokenHash_length",
  "Cart_assisted_consistent",
  "Cart_money_nonnegative",
  "Cart_total_balanced",
  "Cart_itemCount_nonnegative",
  "Cart_pricingIssues_array",
  "CartItem_quantity_positive",
  "CartItem_bundle_consistent",
  "CartItem_snapshots_not_blank",
  "CartItem_money_nonnegative",
  "CartItem_total_balanced",
  "CouponUsage_status_timestamps",
  "CouponUsage_expiration_after_reservation",
  "StoreSettings_uvt_value_valid",
  "StoreSettings_shipping_nonnegative",
  "StoreSettings_reservation_minutes_valid",
  "Order_checkout_money_nonnegative",
  "Order_discount_components_balanced",
  "Order_checkout_snapshot_complete",
  "Order_acceptance_valid",
  "OrderItem_total_balanced",
  "OrderItemTaxLine_tax_balanced",
  "OrderItemReservation_cost_nonnegative",
  "OrderReceipt_contentHash_length",
  "OrderReceipt_total_balanced",
  "AbandonedCart_status_timestamps",
  "OrderNumberSequence_values_valid",
  "DaneDepartment_values_valid",
  "DaneMunicipality_values_valid",
  "Shipment_status_timestamps",
  "OrderRefund_requestHash_length",
  "OrderRefund_total_balanced",
  "OrderRefundItem_total_balanced",
  "PaymentAttempt_requestHash_length",
  "PaymentAttempt_amount_positive",
  "PaymentAttempt_provider_configuration",
  "PaymentAttempt_completion_consistent",
  "PaymentTransaction_requestHash_length",
  "PaymentTransaction_amount_positive",
  "PaymentTransaction_completion_consistent",
  "PaymentWebhookEvent_payloadHash_length",
  "BlockedIdentity_identityHash_length",
  "BlockedIdentity_unblock_consistent",
  "RemittanceBatch_money_nonnegative",
  "CodReconciliation_money_nonnegative",
  "CodReconciliation_reconciled_consistent",
  "StoreCreditAccount_money_nonnegative",
  "StoreCreditEntry_sequence_positive",
  "StoreCreditEntry_requestHash_length",
  "StoreCreditEntry_amount_positive",
  "RemittanceBatch_requestHash_length",
  "StoreCreditEntry_reference_consistent",
  "Order_delivery_coordinates_valid",
  "Order_buyer_document_valid",
  "Order_buyer_fiscal_regime_valid",
  "DomainOutbox_failure_consistent",
  "ShipmentItem_declared_value_nonnegative",
  "LocalDeliveryZone_money_nonnegative",
  "LocalDeliveryZone_polygon_array",
  "OrderFulfillment_provider_configuration",
  "ShipmentPackage_dimensions_positive",
  "ShipmentPackage_requestHash_length",
  "ShipmentPackage_claim_consistent",
  "ShipmentPackage_label_consistent",
  "ShipmentPackage_delivery_consistent",
  "ShipmentPackageItem_quantity_positive",
  "ShipmentPackageItem_declared_value_nonnegative",
  "ShipmentEvent_metadata_object",
  "EmailTemplateOverride_variables_array",
  "EmailEvent_hashes_length",
  "EmailEvent_status_rank_valid",
  "EmailEvent_final_consistent",
  "EmailEvent_content_snapshot_valid",
  "EmailSuppression_recipientHash_length",
  "EmailWebhookEvent_payloadHash_length",
  "TaxInvoice_money_nonnegative",
  "TaxInvoice_total_balanced",
  "TaxInvoice_accepted_consistent",
  "TaxInvoice_claim_consistent",
  "CreditNote_money_nonnegative",
  "CreditNote_total_balanced",
  "CreditNote_accepted_consistent",
  "CreditNote_claim_consistent",
  "Notification_identity_valid",
  "Notification_href_safe",
  "Notification_entity_consistent",
  "DailyFunnelMetric_source_valid",
  "DailyFunnelMetric_counters_nonnegative",
  "FiscalWatchSnapshot_years_valid",
  "FiscalWatchSnapshot_threshold_valid",
  "FiscalWatchSnapshot_money_nonnegative",
  "FiscalWatchSnapshot_net_balanced",
  "FiscalWatchSnapshot_threshold_consistent",
  "BackupRun_status_consistent",
  "BackupRun_timestamps_valid",
  "BackupRun_keys_safe",
  "BackupRun_failure_code_valid",
  "DisasterRecoveryDrill_status_consistent",
  "DisasterRecoveryDrill_timestamps_valid",
  "DisasterRecoveryDrill_failure_code_valid",
  "RecoveryBucketCheck_exactly_one_parent",
  "RecoveryBucketCheck_bucket_valid",
  "RecoveryBucketCheck_evidence_valid",
  "OperationalHealthSnapshot_capture_key_matches",
  "OperationalHealthSnapshot_counters_nonnegative",
  "OperationalHealthSnapshot_database_consistent",
  "OperationalHealthSnapshot_outbox_consistent",
  "ChannelAccount_site_valid",
  "ChannelAccount_external_id_valid",
  "ChannelAccount_label_valid",
  "ChannelAccount_scopes_valid",
  "ChannelAccount_active_scopes",
  "ChannelAccount_status_consistent",
  "ChannelAccount_disconnection_valid",
  "ChannelAccount_refresh_claim_consistent",
  "ChannelAccount_version_nonnegative",
  "ChannelAccount_refresh_error_valid",
  "ChannelOAuthAttempt_site_valid",
  "ChannelOAuthAttempt_label_valid",
  "ChannelOAuthAttempt_state_hash_valid",
  "ChannelOAuthAttempt_expiry_valid",
  "ChannelOAuthAttempt_status_consistent",
  "ChannelOAuthAttempt_completion_valid",
  "ChannelOAuthAttempt_failure_code_valid",
  "ChannelListing_external_ids_valid",
  "ChannelListing_category_valid",
  "ChannelListing_family_name_valid",
  "ChannelListing_warehouse_consistent",
  "ChannelListing_source_hash_length",
  "ChannelListing_version_nonnegative",
  "ChannelListing_quantities_nonnegative",
  "ChannelListing_stock_version_nonnegative",
  "ChannelListing_claim_consistent",
  "ChannelListing_status_consistent",
  "ChannelListing_provider_error_valid",
  "ChannelOffer_external_item_valid",
  "ChannelOffer_listing_type_valid",
  "ChannelOffer_money_nonnegative",
  "ChannelOffer_commission_valid",
  "ChannelOffer_whole_cop_price",
  "ChannelOffer_pricing_mode_consistent",
  "ChannelOffer_fee_thresholds",
  "ChannelOffer_money_balanced",
  "ChannelOffer_stock_quantity_nonnegative",
  "ChannelOffer_source_hash_length",
  "ChannelOffer_version_nonnegative",
  "ChannelOffer_status_consistent",
  "ChannelSyncJob_deduplication_valid",
  "ChannelSyncJob_request_hash_length",
  "ChannelSyncJob_payload_object",
  "ChannelSyncJob_attempts_valid",
  "ChannelSyncJob_claim_consistent",
  "ChannelSyncJob_status_consistent",
  "ChannelSyncJob_failure_code_valid",
  "Address_identity_valid",
  "GuestOrderChallenge_hashes_length",
  "GuestOrderChallenge_attempts_valid",
  "GuestOrderChallenge_status_consistent",
  "GuestOrderSession_tokenHash_length",
  "ReturnRequest_requester_valid",
  "ReturnRequest_requestHash_length",
  "ReturnRequest_refund_deadline_valid",
  "ReturnRequestItem_quantity_positive",
  "WarrantyClaim_requester_valid",
  "WarrantyClaim_requestHash_length",
  "SupportTicket_requester_valid",
  "SupportTicket_ticketNumber_valid",
  "SupportTicket_sla_valid",
  "SupportTicketMessage_author_valid",
  "SupportTicketMessage_body_valid",
  "Review_requester_valid",
  "Review_rating_valid",
  "Review_content_valid",
  "Review_moderation_consistent",
  "Organization_identity_valid",
  "Organization_version_nonnegative",
  "Contact_identity_valid",
  "Contact_status_consistent",
  "Contact_verification_consistent",
  "Contact_retention_valid",
  "Contact_suppression_reason_valid",
  "Contact_version_nonnegative",
  "ContactIdentity_valueHash_length",
  "ContactIdentity_value_valid",
  "ContactIdentity_retirement_valid",
  "IdentityMergeCandidate_pair_valid",
  "IdentityMergeCandidate_arrays_valid",
  "IdentityMergeCandidate_state_consistent",
  "IdentityMergeCandidate_versions_nonnegative",
  "IdentityMergeCandidate_note_valid",
  "ContactActivity_content_valid",
  "ContactActivity_redaction_consistent",
  "Task_content_valid",
  "Task_completion_consistent",
  "Task_version_nonnegative",
  "PriceList_identity_valid",
  "PriceList_state_consistent",
  "PriceListItem_unitPrice_nonnegative",
  "Opportunity_hashes_length",
  "Opportunity_anonymization_consistent",
  "OpportunityProposal_total_balanced",
  "OpportunityProposal_issue_consistent",
  "OpportunityProposalItem_total_balanced",
  "OpportunityCopilotRun_completion_consistent",
  "Cart_b2b_consistent",
  "ReferralCode_identity_valid",
  "ReferralCode_disablement_valid",
  "Referral_parties_distinct",
  "Referral_rejection_reason_valid",
  "Referral_status_consistent",
  "LoyaltyTxn_points_nonzero",
  "LoyaltyTxn_balance_nonnegative",
  "LoyaltyTxn_operation_key_valid",
  "LoyaltyTxn_references_consistent",
  "AbandonedCart_reminders_valid",
  "EmailEvent_growth_relation_valid",
  "CustomerSegment_definitionHash_length",
  "CustomerSegment_status_consistent",
  "CustomerSegmentMembership_sequence_positive",
  "CustomerSegmentMembership_definitionHash_length",
  "CustomerSegmentMembership_metrics_object",
  "CustomerSegmentMembership_reason_valid",
  "LifecycleJourney_version_nonnegative",
  "LifecycleJourney_status_consistent",
  "LifecycleStep_position_valid",
  "LifecycleStep_offset_valid",
  "LifecycleStep_variables_array",
  "LifecycleEnrollment_status_consistent",
  "LifecycleMessage_dispatch_version_nonnegative",
  "LifecycleMessage_status_consistent",
] as const;
const requiredPartialIndexes = [
  "AdminUser_email_active_key",
  "AdminUser_authUserId_active_key",
  "Customer_email_active_key",
  "Customer_authUserId_active_key",
  "IntegrationCredential_provider_environment_accountName_key",
  "Brand_slug_active_key",
  "Category_slug_active_key",
  "Collection_slug_active_key",
  "Product_slug_active_key",
  "ProductVariant_sku_active_key",
  "ProductVariant_gtin_active_key",
  "ProductVariant_ean_active_key",
  "ProductVariant_one_default_active_key",
  "ProductMedia_storageKey_active_key",
  "ProductMedia_posterKey_active_key",
  "ProductMedia_usdzKey_active_key",
  "AttributeDefinition_key_active_key",
  "CompatibilityDevice_slug_active_key",
  "Bundle_slug_active_key",
  "BackInStockSubscription_variantId_email_active_key",
  "UrlRedirect_fromPath_active_key",
  "StockLocation_code_active_key",
  "Supplier_code_active_key",
  "Supplier_taxId_active_key",
  "SerializedUnit_variantId_imei_key",
  "SerializedUnit_imei_active_key",
  "CmsPage_slug_active_key",
  "CmsMedia_storageKey_active_key",
  "CmsMedia_contentHash_active_key",
  "WholesaleTier_scope_target_active_key",
  "Coupon_code_active_key",
  "Cart_assistedTokenHash_key",
  "CartItem_standalone_variant_key",
  "CartItem_bundle_variant_key",
  "CouponUsage_one_reservation_per_cart_key",
  "Order_cartId_key",
  "Order_reservationKey_key",
  "OrderItem_sourceCartItemId_key",
  "BlockedIdentity_kind_identityHash_active_key",
  "PaymentTransaction_one_capture_per_attempt_key",
  "PaymentTransaction_one_void_per_attempt_key",
  "LocalDeliveryZone_code_active_key",
  "ShipmentPackage_one_active_claim_key",
  "EmailTemplateOverride_one_published_key",
  "Address_one_default_active_key",
  "Organization_taxId_active_key",
  "Contact_customer_active_key",
  "IdentityMergeCandidate_pending_pair_key",
  "PriceList_code_active_key",
  "OpportunityProposal_publicTokenHash_key",
  "OpportunityProposal_orderId_key",
  "OpportunityProposal_cartId_key",
  "ChannelOAuthAttempt_one_active_per_account_key",
] as const;
const requiredTotalUniqueIndexes = [
  "ChannelListing_externalUserProductId_key",
  "ChannelListing_accountId_variantId_key",
  "ChannelOffer_externalItemId_key",
  "ChannelOffer_listingId_listingTypeId_logisticType_key",
  "ChannelSyncJob_deduplicationKey_key",
] as const;
const requiredCatalogIndexes = [
  "Product_searchVector_idx",
  "ProductVariant_active_price_idx",
  "ProductVariant_product_active_price_idx",
  "ProductAttributeValue_product_attribute_normalized_idx",
] as const;
const requiredSecurityTriggers = [
  "AdminActionLog_append_only",
  "AdminActionLog_self_dealing",
  "AdminRecoveryCode_immutable_consumption",
  "Consent_append_only",
  "Consent_validate_revocation",
  "IntegrationCredential_immutable_identity",
  "SecurityEvent_append_only",
  "SecurityEvent_dedup_minute",
  "Category_maintain_tree",
  "ProductVariant_validate_identity",
  "ProductVariantOption_validate",
  "ProductAttributeValue_normalize",
  "UrlRedirect_validate",
  "Product_search_after_write",
  "Brand_search_after_write",
  "ProductVariant_search_after_write",
  "ProductAttributeValue_search_after_write",
  "AttributeDefinition_search_after_write",
  "StockLevel_validate",
  "StockLocation_validate_lifecycle",
  "Supplier_validate_lifecycle",
  "ProductVariant_validate_inventory_lifecycle",
  "Product_validate_inventory_lifecycle",
  "SerializedUnit_validate",
  "InventoryLedger_validate",
  "InventoryLedger_append_only",
  "PurchaseOrder_enforce_state",
  "PurchaseOrderItem_enforce_state",
  "CmsBlockVersion_immutable_history",
  "CmsMedia_immutable_identity",
  "CouponUsage_enforce_transition",
  "Order_protect_snapshots",
  "OrderReceipt_validate",
  "OrderRefundItem_validate",
  "Order_validate_balance",
  "OrderRefund_enforce_state",
  "Shipment_enforce_state",
  "OrderRefund_validate_totals",
  "PaymentAttempt_validate",
  "PaymentAttempt_enforce_state",
  "PaymentAttempt_validate_totals",
  "PaymentTransaction_validate",
  "PaymentTransaction_enforce_state",
  "PaymentTransaction_validate_totals",
  "PaymentWebhookEvent_enforce_state",
  "BlockedIdentity_enforce_state",
  "CodReconciliation_validate",
  "CodReconciliation_enforce_state",
  "RemittanceBatch_enforce_state",
  "StoreCreditAccount_enforce_state",
  "StoreCreditAccount_validate_opening",
  "StoreCreditEntry_validate",
  "StoreCreditEntry_append_only",
  "Order_enforce_payment_transition",
  "Order_validate_payment_totals",
  "Order_enforce_f3_4_snapshots",
  "Shipment_enforce_logistics",
  "OrderFulfillment_enforce_state",
  "ShipmentPackage_enforce_state",
  "ShipmentPackageItem_append_only",
  "ShipmentPackage_validate_balance",
  "ShipmentPackageItem_validate_balance",
  "ShipmentEvent_append_only",
  "EmailTemplateOverride_enforce_state",
  "EmailEvent_enforce_state",
  "EmailEvent_enforce_content_snapshot",
  "EmailSuppression_append_only",
  "EmailWebhookEvent_enforce_state",
  "TaxInvoice_enforce_state",
  "TaxInvoice_validate_document",
  "CreditNote_enforce_state",
  "CreditNote_validate_document",
  "SerializedUnit_validate_shipment",
  "Shipment_validate_serial_assignments",
  "Notification_enforce_state",
  "NotificationRead_append_only",
  "DailyFunnelMetric_enforce",
  "FiscalWatchSnapshot_enforce",
  "Customer_enforce_anonymization",
  "Address_validate",
  "GuestOrderChallenge_enforce_state",
  "GuestOrderSession_enforce_state",
  "ReturnRequest_validate_requester",
  "ReturnRequestItem_validate",
  "ReturnRequestUnit_validate",
  "ReturnRequest_enforce_state",
  "WarrantyClaim_validate_requester",
  "WarrantyClaim_validate_serial",
  "WarrantyClaim_enforce_state",
  "SupportTicket_validate_requester",
  "SupportTicketMessage_validate",
  "SupportTicketMessage_append_only",
  "SupportTicket_enforce_state",
  "Review_validate_requester",
  "Review_enforce_moderation",
  "Organization_prevent_delete",
  "Contact_enforce_state",
  "ContactIdentity_enforce_state",
  "IdentityMergeCandidate_enforce_state",
  "ContactActivity_enforce_state",
  "Task_enforce_state",
  "PriceListItem_enforce_mutable",
  "PriceList_enforce_state",
  "Organization_enforce_price_list",
  "Opportunity_enforce_state",
  "OpportunityProposal_enforce_state",
  "OpportunityProposalItem_immutable_update",
  "OpportunityProposalItem_immutable_delete",
  "OpportunityCopilotRun_enforce_state",
  "ReferralCode_enforce_state",
  "Referral_enforce_state",
  "LoyaltyTxn_validate",
  "LoyaltyTxn_append_only",
  "EmailEvent_validate_growth_relation",
  "CustomerSegment_enforce_state",
  "CustomerSegmentMembership_append_only",
  "LifecycleJourney_enforce_state",
  "LifecycleStep_enforce_state",
  "LifecycleEnrollment_enforce_state",
  "LifecycleMessage_enforce_state",
  "ChannelAccount_credential_binding",
  "ChannelOAuthAttempt_credential_binding",
  "ChannelAccount_enforce_state",
  "ChannelOAuthAttempt_enforce_state",
  "IntegrationCredential_channel_binding",
  "ChannelOAuthAttempt_credential_revocation",
  "ChannelListing_enforce_state",
  "ChannelOffer_enforce_state",
  "ChannelSyncJob_enforce_state",
] as const;
const requiredEventTriggers = [
  "enforce_rls_on_new_table",
  "revoke_postgrest_on_new_function",
] as const;

export async function verifySecurityPosture(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const errors: string[] = [];

  try {
    await client.connect();
    const version = await client.query<{ server_version: string; server_version_num: string }>(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num",
    );
    const versionRow = version.rows[0];
    if (
      !versionRow ||
      Number(versionRow.server_version_num) < 170000 ||
      Number(versionRow.server_version_num) >= 180000
    ) {
      errors.push(`PostgreSQL 17 is required; found ${versionRow?.server_version ?? "unknown"}.`);
    }

    const roleFlags = await client.query<{
      role_name: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname AS role_name, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [nonBypassRoles],
    );
    for (const role of nonBypassRoles) {
      const row = roleFlags.rows.find((item) => item.role_name === role);
      if (!row || row.rolsuper || row.rolbypassrls) {
        errors.push(`Role ${role} must exist without SUPERUSER or BYPASSRLS.`);
      }
    }

    const tables = await client.query<{
      table_name: string;
      row_security: boolean;
      force_row_security: boolean;
    }>(
      `SELECT cls.relname AS table_name, cls.relrowsecurity AS row_security,
              cls.relforcerowsecurity AS force_row_security
       FROM pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p')
         AND cls.relname <> '_prisma_migrations'
       ORDER BY cls.relname`,
    );
    const tableRows = tables.rows;

    for (const requiredTable of requiredTables) {
      const table = tableRows.find((row) => row.table_name === requiredTable);
      if (!table) {
        errors.push(`Missing required table ${requiredTable}.`);
      } else if (!table.row_security || !table.force_row_security) {
        errors.push(`${requiredTable} must have RLS enabled and forced.`);
      }
    }
    for (const table of tableRows) {
      if (!table.row_security || !table.force_row_security) {
        errors.push(`Public table ${table.table_name} is not deny-by-default.`);
      }
    }

    const exposedPolicies = await client.query<{
      table_name: string;
      policy_name: string;
    }>(
      `SELECT cls.relname AS table_name, pol.polname AS policy_name
       FROM pg_policy pol
       JOIN pg_class cls ON cls.oid = pol.polrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public'
         AND (
           pol.polroles = '{0}'::oid[] OR
           EXISTS (
             SELECT 1 FROM pg_roles r
             WHERE r.oid = ANY(pol.polroles)
               AND r.rolname = ANY($1::text[])
           )
         )`,
      [dataApiRoles],
    );
    for (const row of exposedPolicies.rows) {
      errors.push(
        `Policy ${row.policy_name} on ${row.table_name} exposes public schema data to PUBLIC or Data API roles.`,
      );
    }

    const schemaPrivileges = await client.query<{
      role_name: string;
      has_usage: boolean;
      has_create: boolean;
    }>(
      `SELECT role.rolname AS role_name,
              has_schema_privilege(role.oid, 'public', 'USAGE') AS has_usage,
              has_schema_privilege(role.oid, 'public', 'CREATE') AS has_create
       FROM pg_roles role WHERE role.rolname = ANY($1::text[])`,
      [dataApiRoles],
    );
    for (const role of dataApiRoles) {
      const row = schemaPrivileges.rows.find((item) => item.role_name === role);
      if (!row || row.has_usage || row.has_create) {
        errors.push(`PostgREST role ${role} retains public schema privileges.`);
      }
    }

    const relationPrivileges = await client.query<{
      role_name: string;
      relation_name: string;
      privilege: string;
    }>(
      `SELECT role.rolname AS role_name, cls.relname AS relation_name, privilege
       FROM pg_roles role
       CROSS JOIN pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(ARRAY[
         'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
       ]) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_table_privilege(role.oid, cls.oid, privilege)`,
      [dataApiRoles],
    );
    for (const row of relationPrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains ${row.privilege} on ${row.relation_name}.`,
      );
    }

    const sequencePrivileges = await client.query<{
      role_name: string;
      sequence_name: string;
      privilege: string;
    }>(
      `SELECT role.rolname AS role_name, cls.relname AS sequence_name, privilege
       FROM pg_roles role
       CROSS JOIN pg_class cls
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       CROSS JOIN LATERAL unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS privilege
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public' AND cls.relkind = 'S'
         AND has_sequence_privilege(role.oid, cls.oid, privilege)`,
      [dataApiRoles],
    );
    for (const row of sequencePrivileges.rows) {
      errors.push(
        `PostgREST role ${row.role_name} retains ${row.privilege} on sequence ${row.sequence_name}.`,
      );
    }

    const functionPrivileges = await client.query<{ role_name: string; function_name: string }>(
      `SELECT role.rolname AS role_name, proc.proname AS function_name
       FROM pg_roles role
       CROSS JOIN pg_proc proc
       JOIN pg_namespace ns ON ns.oid = proc.pronamespace
       WHERE role.rolname = ANY($1::text[])
         AND ns.nspname = 'public'
         AND has_function_privilege(role.oid, proc.oid, 'EXECUTE')`,
      [dataApiRoles],
    );
    for (const row of functionPrivileges.rows) {
      errors.push(`PostgREST role ${row.role_name} can execute ${row.function_name}.`);
    }

    const publicPrivileges = await client.query<{
      schema_usage: boolean;
      relation_name: string | null;
      function_name: string | null;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_namespace ns
         CROSS JOIN LATERAL aclexplode(ns.nspacl) AS acl
         WHERE ns.nspname = 'public' AND acl.grantee = 0
           AND acl.privilege_type IN ('USAGE', 'CREATE')
       ) AS schema_usage,
       (SELECT cls.relname FROM pg_class cls
        JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND EXISTS (
            SELECT 1 FROM aclexplode(cls.relacl) AS acl
            WHERE acl.grantee = 0
          ) LIMIT 1) AS relation_name,
       (SELECT proc.proname FROM pg_proc proc
        JOIN pg_namespace ns ON ns.oid = proc.pronamespace
        WHERE ns.nspname = 'public' AND (
          proc.proacl IS NULL OR EXISTS (
            SELECT 1 FROM aclexplode(proc.proacl) AS acl
            WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          )
        ) LIMIT 1) AS function_name`,
    );
    const publicRow = publicPrivileges.rows[0];
    if (publicRow?.schema_usage || publicRow?.relation_name || publicRow?.function_name) {
      const target = publicRow.relation_name ?? publicRow.function_name;
      errors.push(
        `PUBLIC retains schema, relation, or function privileges${target ? ` (${target})` : ""}.`,
      );
    }

    const eventTriggers = await client.query<{ name: string; enabled: string }>(
      "SELECT evtname AS name, evtenabled AS enabled FROM pg_event_trigger WHERE evtname = ANY($1::text[])",
      [requiredEventTriggers],
    );
    for (const requiredTrigger of requiredEventTriggers) {
      const trigger = eventTriggers.rows.find((item) => item.name === requiredTrigger);
      if (!trigger || trigger.enabled !== "O") {
        errors.push(`Event trigger ${requiredTrigger} is missing or disabled.`);
      }
    }

    const rowTriggers = await client.query<{ trigger_name: string; enabled: string }>(
      `SELECT tg.tgname AS trigger_name, tg.tgenabled AS enabled
       FROM pg_trigger tg
       JOIN pg_class cls ON cls.oid = tg.tgrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'public' AND NOT tg.tgisinternal
         AND tg.tgname = ANY($1::text[])`,
      [requiredSecurityTriggers],
    );
    for (const requiredTrigger of requiredSecurityTriggers) {
      const row = rowTriggers.rows.find((item) => item.trigger_name === requiredTrigger);
      if (!row || row.enabled !== "O") {
        errors.push(`Security trigger ${requiredTrigger} is missing or disabled.`);
      }
    }

    const constraints = await client.query<{ constraint_name: string }>(
      `SELECT conname AS constraint_name FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[])`,
      [requiredConstraints],
    );
    for (const required of requiredConstraints) {
      if (!constraints.rows.some((row) => row.constraint_name === required)) {
        errors.push(`Missing integrity constraint ${required}.`);
      }
    }

    const indexes = await client.query<{ index_name: string; index_definition: string }>(
      `SELECT indexname AS index_name, indexdef AS index_definition
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])`,
      [[...requiredPartialIndexes, ...requiredTotalUniqueIndexes, ...requiredCatalogIndexes]],
    );
    for (const required of requiredPartialIndexes) {
      const index = indexes.rows.find((row) => row.index_name === required);
      if (
        !index ||
        !index.index_definition.startsWith("CREATE UNIQUE INDEX") ||
        !index.index_definition.includes(" WHERE ")
      ) {
        errors.push(`Missing partial unique index ${required}.`);
      }
    }
    for (const required of requiredTotalUniqueIndexes) {
      const index = indexes.rows.find((row) => row.index_name === required);
      if (!index || !index.index_definition.startsWith("CREATE UNIQUE INDEX")) {
        errors.push(`Missing unique index ${required}.`);
      }
    }
    for (const required of requiredCatalogIndexes) {
      const index = indexes.rows.find((row) => row.index_name === required);
      if (!index) errors.push(`Missing catalog index ${required}.`);
      if (
        required === "Product_searchVector_idx" &&
        index &&
        !/USING gin/i.test(index.index_definition)
      ) {
        errors.push("Product_searchVector_idx must use GIN.");
      }
    }

    const migrations = await client.query<{ total: number; healthy: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS healthy
       FROM _prisma_migrations`,
    );
    const migration = migrations.rows[0];
    if (!migration || migration.total === 0 || migration.total !== migration.healthy) {
      errors.push("The Prisma migration chain contains missing, failed, or rolled-back entries.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Unknown database verification error.");
  } finally {
    await client.end().catch(() => undefined);
  }

  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
  const errors = await verifySecurityPosture(databaseUrl);

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(
      `Database security posture verified on PostgreSQL 17: ${requiredTables.length} protected tables.`,
    );
  }
}
