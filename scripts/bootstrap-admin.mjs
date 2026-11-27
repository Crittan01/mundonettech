import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { createDatabaseClient } from "../packages/db/dist/index.js";
import {
  isPasswordCompromised,
  maskEmail,
  normalizeEmail,
  validatePasswordPolicy,
} from "../packages/core/dist/index.js";

const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL ?? "");
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const displayName = (process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME ?? "").trim();
if (
  displayName.length < 2 ||
  displayName.length > 120 ||
  [...displayName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  })
) {
  throw new Error(
    "BOOTSTRAP_ADMIN_DISPLAY_NAME must contain 2 to 120 characters without control characters.",
  );
}
const passwordIssues = validatePasswordPolicy(password);
if (passwordIssues.length > 0)
  throw new Error("Bootstrap password does not satisfy the security policy.");
if (await isPasswordCompromised(password))
  throw new Error("Bootstrap password appears in known breaches.");

function localAdminConfig() {
  const runtime = spawnSync("podman", ["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
    encoding: "utf8",
  });
  if (runtime.status !== 0 || !runtime.stdout.trim()) {
    throw new Error("Rootless Podman is unavailable.");
  }
  const status = spawnSync("pnpm", ["exec", "supabase", "status", "-o", "env", "--workdir", "."], {
    encoding: "utf8",
    env: { ...process.env, DOCKER_HOST: `unix://${runtime.stdout.trim()}` },
  });
  if (status.status !== 0) throw new Error("Local Supabase is not running.");
  const read = (name) => status.stdout.match(new RegExp(`^${name}="(.*)"$`, "m"))?.[1];
  return {
    url: read("API_URL") ?? "http://127.0.0.1:54421",
    serviceKey: read("SERVICE_ROLE_KEY") ?? read("SECRET_KEY"),
    databaseUrl: read("DB_URL") ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
  };
}

const local = process.env.SUPABASE_SERVICE_ROLE_KEY ? null : localAdminConfig();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? local?.url;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? local?.serviceKey;
const databaseUrl = process.env.DATABASE_URL?.trim() || local?.databaseUrl;
if (!supabaseUrl || !serviceKey) throw new Error("Supabase admin credentials are unavailable.");
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required when using explicit Supabase credentials.");
}
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = createDatabaseClient({
  databaseUrl,
  maxConnections: 2,
});

async function findExistingAuthUser() {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
  throw new Error("Unable to finish the auth user lookup safely.");
}

try {
  const existingProfile = await db.adminUser.findFirst({ where: { email, deletedAt: null } });
  if (existingProfile) {
    if (existingProfile.role !== "SUPERADMIN" || existingProfile.status !== "ACTIVE") {
      throw new Error("The email already belongs to a non-bootstrap administrator.");
    }
    console.log(`Bootstrap administrator already exists: ${maskEmail(email)}.`);
  } else {
    let authUser;
    let createdAuthUser = false;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (created.error || !created.data.user) {
      const existing = await findExistingAuthUser();
      if (!existing) {
        throw new Error(
          `Unable to create Supabase Auth bootstrap user: ${created.error?.message ?? "unknown error"}.`,
        );
      }
      if (process.env.BOOTSTRAP_ADMIN_LINK_EXISTING !== "YES") {
        throw new Error(
          "Auth user exists; set BOOTSTRAP_ADMIN_LINK_EXISTING=YES only after verifying ownership.",
        );
      }
      if (!existing.email_confirmed_at) {
        throw new Error("Existing Auth user must have a confirmed email before linking.");
      }
      const existingCustomer = await db.customer.findFirst({
        where: { authUserId: existing.id },
        select: { id: true },
      });
      if (existingCustomer) {
        throw new Error("Existing Auth user is already bound to a customer account.");
      }
      authUser = existing;
    } else {
      authUser = created.data.user;
      createdAuthUser = true;
    }

    try {
      await db.$transaction(async (tx) => {
        const profile = await tx.adminUser.create({
          data: {
            authUserId: authUser.id,
            email,
            displayName,
            role: "SUPERADMIN",
            status: "ACTIVE",
          },
        });
        await tx.adminActionLog.create({
          data: {
            actorAdminUserId: profile.id,
            targetAdminUserId: profile.id,
            action: "ADMIN_BOOTSTRAPPED",
            targetType: "AdminUser",
            targetId: profile.id,
            requestId: randomUUID(),
            metadata: { source: "bootstrap_cli" },
          },
        });
      });
    } catch (error) {
      if (createdAuthUser) {
        try {
          const rollback = await admin.auth.admin.deleteUser(authUser.id);
          if (rollback.error) {
            console.error("Warning: failed to roll back newly created bootstrap Auth user.");
          }
        } catch {
          console.error("Warning: failed to roll back newly created bootstrap Auth user.");
        }
      }
      throw error;
    }
    console.log(
      `Bootstrap administrator created: ${maskEmail(email)}. Complete TOTP enrollment on first login.`,
    );
  }
} finally {
  await db.$disconnect();
}
