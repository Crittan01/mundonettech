"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { adminRoles, canAssignAdminRole, type AdminRoleValue } from "@mundonettech/core";
import { initialActionState, type ActionState } from "@/lib/action-state";
import { inviteAdministratorAction, updateAdministratorAction } from "@/lib/actions/admin-users";

export function InviteAdministratorForm({
  actorRole,
  labels,
}: {
  actorRole: AdminRoleValue;
  labels: Record<AdminRoleValue, string>;
}) {
  const [state, action, pending] = useActionState(inviteAdministratorAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);
  const handledSuccess = useRef<ActionState | null>(null);
  const roles = adminRoles.filter((role) => canAssignAdminRole(actorRole, role));
  useEffect(() => {
    if (state.status === "success" && handledSuccess.current !== state) {
      handledSuccess.current = state;
      formRef.current?.reset();
    }
  }, [state]);
  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
    >
      <div className="space-y-2">
        <Label htmlFor="invite-email">Correo</Label>
        <Input
          id="invite-email"
          name="email"
          type="email"
          required
          maxLength={320}
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-name">Nombre</Label>
        <Input
          id="invite-name"
          name="displayName"
          required
          minLength={2}
          maxLength={120}
          disabled={pending}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-role">Rol</Label>
        <Select id="invite-role" name="role" required disabled={pending}>
          {roles.map((role) => (
            <option key={role} value={role}>
              {labels[role]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={pending || roles.length === 0}>
          {pending ? "Invitando…" : "Enviar invitación"}
        </Button>
      </div>
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function AdministratorEditor({
  target,
  actorRole,
  labels,
}: {
  target: {
    id: string;
    role: AdminRoleValue;
    status: "INVITED" | "ACTIVE" | "SUSPENDED";
    canReactivate?: boolean;
  };
  actorRole: AdminRoleValue;
  labels: Record<AdminRoleValue, string>;
}) {
  const [state, action, pending] = useActionState(updateAdministratorAction, initialActionState);
  const roles = adminRoles.filter((role) => canAssignAdminRole(actorRole, role));
  const allowedStatuses: Array<{ value: "INVITED" | "ACTIVE" | "SUSPENDED"; label: string }> =
    target.status === "INVITED"
      ? [
          { value: "INVITED", label: "Invitado" },
          { value: "SUSPENDED", label: "Suspendido" },
        ]
      : target.status === "ACTIVE"
        ? [
            { value: "ACTIVE", label: "Activo" },
            { value: "SUSPENDED", label: "Suspendido" },
          ]
        : target.canReactivate === false
          ? [{ value: "SUSPENDED", label: "Suspendido" }]
          : [
              { value: "SUSPENDED", label: "Suspendido" },
              { value: "ACTIVE", label: "Activo" },
            ];
  if (!canAssignAdminRole(actorRole, target.role)) {
    return (
      <p className="text-sm text-muted-foreground">
        Solo lectura: tu rol no permite administrar una cuenta de este anillo.
      </p>
    );
  }
  return (
    <form
      key={`${target.role}:${target.status}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
      aria-busy={pending}
      className="space-y-3"
    >
      <input type="hidden" name="targetId" value={target.id} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={`role-${target.id}`}>Nuevo rol</Label>
          <Select
            id={`role-${target.id}`}
            name="role"
            defaultValue={target.role}
            disabled={pending}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {labels[role]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`status-${target.id}`}>Nuevo estado</Label>
          <Select
            id={`status-${target.id}`}
            name="status"
            defaultValue={target.status}
            disabled={pending}
          >
            {allowedStatuses.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
