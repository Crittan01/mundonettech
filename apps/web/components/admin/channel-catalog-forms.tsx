"use client";

import { useActionState, useState } from "react";

import type {
  ChannelListingView,
  ChannelOfferView,
  ChannelVariantChoice,
} from "@mundonettech/integrations";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addChannelOfferAction,
  createChannelListingAction,
  processChannelSyncJobsAction,
  synchronizeChannelListingAction,
  updateChannelOfferAction,
} from "@/lib/actions/admin-channel-catalog";
import { initialActionState } from "@/lib/action-state";

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function wholeCop(cents: string | null): string {
  return cents ? (BigInt(cents) / 100n).toString() : "";
}

function OfferFields({
  suffix,
  offer,
  values,
  targetNetCents,
  fulfillment,
}: {
  readonly suffix: string;
  readonly offer?: ChannelOfferView | undefined;
  readonly values?: Record<string, string> | undefined;
  readonly targetNetCents?: string | undefined;
  readonly fulfillment?: boolean | undefined;
}) {
  const [mode, setMode] = useState(values?.pricingMode ?? offer?.pricingMode ?? "FORMULA");
  const value = (key: string, fallback = "") => values?.[key] ?? fallback;
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`pricing-mode-${suffix}`}>Modo de precio</Label>
          <select
            id={`pricing-mode-${suffix}`}
            name="pricingMode"
            className={selectClass}
            value={mode}
            onChange={(event) => setMode(event.target.value as "FORMULA" | "MANUAL")}
          >
            <option value="FORMULA">Fórmula por neto objetivo</option>
            <option value="MANUAL">Manual</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`listing-type-${suffix}`}>Exposición</Label>
          <select
            id={`listing-type-${suffix}`}
            name="listingTypeId"
            className={selectClass}
            defaultValue={value("listingTypeId", offer?.listingTypeId ?? "gold_special")}
          >
            <option value="gold_special">Clásica</option>
            <option value="gold_pro">Premium</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`logistic-${suffix}`}>Logística</Label>
          <select
            id={`logistic-${suffix}`}
            name="logisticType"
            className={selectClass}
            defaultValue={value(
              "logisticType",
              offer?.logisticType ?? (fulfillment ? "FULFILLMENT" : "CROSS_DOCKING"),
            )}
          >
            <option value="CROSS_DOCKING">Bodega local / Flex</option>
            <option value="FULFILLMENT">Mercado Libre Full</option>
          </select>
        </div>
      </div>
      {mode === "FORMULA" ? (
        <div className="space-y-2">
          <Label htmlFor={`target-net-${suffix}`}>Neto objetivo por unidad (COP)</Label>
          <Input
            id={`target-net-${suffix}`}
            name="targetNetCop"
            inputMode="numeric"
            pattern="[0-9]+"
            maxLength={15}
            defaultValue={value(
              "targetNetCop",
              wholeCop(offer?.targetNetCents ?? targetNetCents ?? null),
            )}
            required
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`manual-price-${suffix}`}>Precio de venta (COP, pesos enteros)</Label>
          <Input
            id={`manual-price-${suffix}`}
            name="manualPriceCop"
            inputMode="numeric"
            pattern="[0-9]+"
            maxLength={15}
            defaultValue={value("manualPriceCop", wholeCop(offer?.manualPriceCents ?? null))}
            required
          />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={`commission-${suffix}`}>Comisión (puntos básicos)</Label>
          <Input
            id={`commission-${suffix}`}
            name="commissionBps"
            inputMode="numeric"
            pattern="[0-9]{1,4}"
            maxLength={4}
            placeholder="Ej.: 1000 = 10 %"
            defaultValue={value("commissionBps", offer ? String(offer.commissionBps) : "")}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`fixed-fee-${suffix}`}>Cargo fijo bajo $60.000 (COP)</Label>
          <Input
            id={`fixed-fee-${suffix}`}
            name="fixedFeeCop"
            inputMode="numeric"
            pattern="[0-9]+"
            maxLength={15}
            placeholder="0"
            defaultValue={value("fixedFeeCop", wholeCop(offer?.fixedFeeCents ?? null))}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`shipping-${suffix}`}>Flete asumido desde $60.000 (COP)</Label>
          <Input
            id={`shipping-${suffix}`}
            name="shippingCostCop"
            inputMode="numeric"
            pattern="[0-9]+"
            maxLength={15}
            placeholder="0"
            defaultValue={value("shippingCostCop", wholeCop(offer?.shippingCostCents ?? null))}
            required
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Registra tus tarifas vigentes. Usa cero únicamente cuando el cargo realmente no aplique; el
        sistema no estima comisiones ni fletes por ti.
      </p>
    </div>
  );
}

export function ChannelListingCreateForm({
  accounts,
  variants,
}: {
  readonly accounts: readonly { readonly id: string; readonly label: string }[];
  readonly variants: readonly ChannelVariantChoice[];
}) {
  const [state, action, pending] = useActionState(createChannelListingAction, initialActionState);
  const initialVariant = state.values?.variantId ?? variants[0]?.id ?? "";
  const [variantId, setVariantId] = useState(initialVariant);
  const selected = variants.find((variant) => variant.id === variantId) ?? variants[0];
  if (!selected) return null;
  return (
    <form action={action} className="space-y-4" aria-busy={pending}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="listing-account">Cuenta vendedora</Label>
          <select
            id="listing-account"
            name="accountId"
            className={selectClass}
            defaultValue={state.values?.accountId ?? accounts[0]?.id}
            required
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="listing-variant">Variante del catálogo</Label>
          <select
            id="listing-variant"
            name="variantId"
            className={selectClass}
            value={variantId}
            onChange={(event) => setVariantId(event.target.value)}
            required
          >
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.sku} · {variant.productName} · local {variant.localQuantity} / Full{" "}
                {variant.fullQuantity}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="listing-category">Categoría MCO de Mercado Libre</Label>
          <Input
            id="listing-category"
            name="externalCategoryId"
            placeholder="MCO12345"
            pattern="MCO[0-9]+"
            maxLength={32}
            defaultValue={state.values?.externalCategoryId}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="listing-family">Nombre de familia</Label>
          <Input
            key={selected.id}
            id="listing-family"
            name="familyName"
            maxLength={200}
            defaultValue={state.values?.familyName ?? selected.productName}
            required
          />
          <p className="text-xs text-muted-foreground">
            No incluyas atributos de la variante; Mercado Libre los añade al título.
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="listing-store">Store ID multi-origen (opcional)</Label>
          <Input
            id="listing-store"
            name="sellerStoreId"
            maxLength={64}
            defaultValue={state.values?.sellerStoreId}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="listing-node">Network node ID multi-origen (opcional)</Label>
          <Input
            id="listing-node"
            name="sellerNetworkNodeId"
            maxLength={64}
            defaultValue={state.values?.sellerNetworkNodeId}
          />
        </div>
      </div>
      <OfferFields
        key={selected.id}
        suffix={`create-${selected.id}`}
        values={state.values}
        targetNetCents={selected.priceCents}
        fulfillment={selected.localQuantity === 0 && selected.fullQuantity > 0}
      />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Persistiendo publicación…" : "Preparar publicación"}
      </Button>
    </form>
  );
}

export function ChannelOfferEditForm({ offer }: { readonly offer: ChannelOfferView }) {
  const [state, action, pending] = useActionState(updateChannelOfferAction, initialActionState);
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">Editar precio y tarifas</summary>
      <form action={action} className="mt-4 space-y-4" aria-busy={pending}>
        <input type="hidden" name="offerId" value={offer.id} />
        <OfferFields suffix={`edit-${offer.id}`} offer={offer} values={state.values} />
        <FormMessage state={state} />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Guardando cambios…" : "Guardar y programar precio"}
        </Button>
      </form>
    </details>
  );
}

export function ChannelOfferAddForm({ listing }: { readonly listing: ChannelListingView }) {
  const [state, action, pending] = useActionState(addChannelOfferAction, initialActionState);
  const reference = listing.offers[0];
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">Añadir condición de venta</summary>
      <form action={action} className="mt-4 space-y-4" aria-busy={pending}>
        <input type="hidden" name="listingId" value={listing.id} />
        <OfferFields
          suffix={`add-${listing.id}`}
          values={state.values}
          targetNetCents={reference?.targetNetCents ?? reference?.priceCents ?? "0"}
          fulfillment={!listing.offers.some((offer) => offer.logisticType === "FULFILLMENT")}
        />
        <FormMessage state={state} />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Añadiendo condición…" : "Añadir y programar publicación"}
        </Button>
      </form>
    </details>
  );
}

function SyncButton({
  listingId,
  offerId,
  kind,
  label,
  pendingLabel,
  desiredStatus,
  force = false,
  confirmation = false,
  destructive = false,
}: {
  readonly listingId: string;
  readonly offerId?: string;
  readonly kind: "SYNC_PRICE" | "SYNC_CONTENT" | "SYNC_LOCAL_STOCK" | "RECONCILE_REMOTE";
  readonly label: string;
  readonly pendingLabel: string;
  readonly desiredStatus?: "ACTIVE" | "PAUSED" | "CLOSED";
  readonly force?: boolean;
  readonly confirmation?: boolean;
  readonly destructive?: boolean;
}) {
  const [state, action, pending] = useActionState(
    synchronizeChannelListingAction,
    initialActionState,
  );
  return (
    <form action={action} className="space-y-3" aria-busy={pending}>
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="offerId" value={offerId ?? ""} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="desiredStatus" value={desiredStatus ?? ""} />
      <input type="hidden" name="force" value={String(force)} />
      {confirmation ? (
        <div className="space-y-2">
          <Label htmlFor={`close-${listingId}`}>Escribe CERRAR para confirmar</Label>
          <Input
            id={`close-${listingId}`}
            name="confirmation"
            minLength={6}
            maxLength={6}
            required
          />
        </div>
      ) : null}
      <Button type="submit" variant={destructive ? "destructive" : "outline"} disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ChannelListingSyncActions({ listing }: { readonly listing: ChannelListingView }) {
  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap gap-2">
        {listing.offers.map((offer) => (
          <div key={offer.id} className="flex flex-wrap gap-2">
            <SyncButton
              listingId={listing.id}
              offerId={offer.id}
              kind="SYNC_PRICE"
              label={`Sincronizar precio ${offer.externalItemId ?? "borrador"}`}
              pendingLabel="Sincronizando precio…"
            />
            <SyncButton
              listingId={listing.id}
              offerId={offer.id}
              kind="SYNC_LOCAL_STOCK"
              label={
                offer.logisticType === "FULFILLMENT" ? "Leer stock Full" : "Sincronizar stock local"
              }
              pendingLabel="Conciliando stock…"
            />
          </div>
        ))}
        <SyncButton
          listingId={listing.id}
          kind="RECONCILE_REMOTE"
          label="Conciliar estado remoto"
          pendingLabel="Conciliando…"
          force={listing.lastProviderError !== null}
        />
      </div>
      {listing.externalUserProductId && listing.status !== "CLOSED" ? (
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <SyncButton
            listingId={listing.id}
            kind="SYNC_CONTENT"
            desiredStatus={listing.status === "PAUSED" ? "ACTIVE" : "PAUSED"}
            label={listing.status === "PAUSED" ? "Reactivar publicación" : "Pausar publicación"}
            pendingLabel="Actualizando estado…"
            force
          />
          <details>
            <summary className="cursor-pointer text-sm font-medium text-destructive">
              Cerrar publicación definitivamente
            </summary>
            <div className="mt-3">
              <SyncButton
                listingId={listing.id}
                kind="SYNC_CONTENT"
                desiredStatus="CLOSED"
                label="Cerrar en Mercado Libre"
                pendingLabel="Cerrando…"
                confirmation
                destructive
                force
              />
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function ProcessChannelJobsButton() {
  const [state, action, pending] = useActionState(processChannelSyncJobsAction, initialActionState);
  return (
    <form action={action} aria-busy={pending}>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Procesando trabajos…" : "Procesar trabajos pendientes"}
      </Button>
      {pending ? null : <FormMessage state={state} />}
    </form>
  );
}
