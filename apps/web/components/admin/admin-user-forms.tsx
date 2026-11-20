"use client";

import { useActionState } from "react";

import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adminRoles, canAssignAdminRole, type AdminRoleValue } from "@mundonettech/core";
import { initialActionState } from "@/lib/action-state";
import { inviteAdministratorAction, updateAdministratorAction } from "@/lib/actions/admin-users";

export function InviteAdministratorForm({
  actorRole,
  labels,
}: {
  actorRole: AdminRoleValue;
  labels: Record<AdminRoleValue, string>;
}) {
  const [state, action, pending] = useActionState(inviteAdministratorAction, initialActionState);
  const roles = adminRoles.filter((role) => canAssignAdminRole(actorRole, role));
  return (
    <form
      action={action}
      className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
    >
      <div className="space-y-2">
        <Label htmlFor="invite-email">Correo</Label>
        <Input id="invite-email" name="email" type="email" required maxLength={320} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-name">Nombre</Label>
        <Input id="invite-name" name="displayName" required minLength={2} maxLength={120} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-role">Rol</Label>
        <select
          id="invite-role"
          name="role"
          className="h-11 rounded-md border border-input bg-background px-3 text-sm"
          required
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {labels[role]}
            </option>
          ))}
        </select>
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
  target: { id: string; role: AdminRoleValue; status: "INVITED" | "ACTIVE" | "SUSPENDED" };
  actorRole: AdminRoleValue;
  labels: Record<AdminRoleValue, string>;
}) {
  const [state, action, pending] = useActionState(updateAdministratorAction, initialActionState);
  const roles = adminRoles.filter((role) => canAssignAdminRole(actorRole, role));
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="targetId" value={target.id} />
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <select
          aria-label="Nuevo rol"
          name="role"
          defaultValue={target.role}
          className="h-10 rounded-md border border-input bg-background px-2 text-sm"
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {labels[role]}
            </option>
          ))}
        </select>
        <select
          aria-label="Nuevo estado"
          name="status"
          defaultValue={target.status}
          className="h-10 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="INVITED">Invitado</option>
          <option value="ACTIVE">Activo</option>
          <option value="SUSPENDED">Suspendido</option>
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
