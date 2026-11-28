import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const runtime = spawnSync("podman", ["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
  encoding: "utf8",
});
if (runtime.status !== 0 || !runtime.stdout.trim())
  throw new Error("Rootless Podman socket is unavailable.");
const status = spawnSync("pnpm", ["exec", "supabase", "status", "-o", "env", "--workdir", "."], {
  encoding: "utf8",
  env: { ...process.env, DOCKER_HOST: `unix://${runtime.stdout.trim()}` },
});
if (status.status !== 0)
  throw new Error("Start local Supabase before configuring the web environment.");

function variable(name) {
  return status.stdout.match(new RegExp(`^${name}="(.*)"$`, "m"))?.[1];
}

const publishableKey = variable("PUBLISHABLE_KEY") ?? variable("ANON_KEY");
const serviceRoleKey = variable("SERVICE_ROLE_KEY") ?? variable("SECRET_KEY");
if (!publishableKey || !serviceRoleKey) throw new Error("Local Supabase keys are unavailable.");
const secret = () => randomBytes(32).toString("base64");
const localVaultKeyRing = JSON.stringify({ 1: secret() });
const entries = [
  ["NEXT_PUBLIC_SITE_URL", '"http://127.0.0.1:4010"'],
  ["SITE_URL", '"http://127.0.0.1:4010"'],
  ["NEXT_PUBLIC_MEDIA_BASE_URL", '"http://127.0.0.1:4010"'],
  ["NEXT_PUBLIC_SUPABASE_URL", '"http://127.0.0.1:54421"'],
  ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", `"${publishableKey}"`],
  ["SUPABASE_SERVICE_ROLE_KEY", `"${serviceRoleKey}"`],
  ["DATABASE_URL", '"postgresql://postgres:postgres@127.0.0.1:54422/postgres"'],
  ["INTEGRATION_ENVIRONMENT", '"LOCAL"'],
  ["INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL", '"1"'],
  ["INTEGRATION_CREDENTIAL_KEYS_LOCAL", `'${localVaultKeyRing}'`],
  ["SESSION_TIMEOUT_SECRET", `"${secret()}"`],
  ["SECURITY_EVENT_PEPPER", `"${secret()}"`],
  ["RECOVERY_CODE_PEPPER", `"${secret()}"`],
  ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", '"1x00000000000000000000AA"'],
  ["TURNSTILE_SECRET_KEY", '"1x0000000000000000000000000000000AA"'],
];
const target = path.resolve("apps/web/.env.local");
if (!existsSync(target)) {
  const contents = `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
  writeFileSync(target, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log("Created apps/web/.env.local with local-only credentials and random secrets.");
} else {
  const existing = readFileSync(target, "utf8");
  const missing = entries.filter(([key]) => !new RegExp(`^${key}=`, "m").test(existing));
  if (missing.length > 0) {
    const suffix = `${existing.endsWith("\n") ? "" : "\n"}${missing
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`;
    writeFileSync(target, `${existing}${suffix}`, { encoding: "utf8", mode: 0o600 });
    console.log(
      `Updated apps/web/.env.local with missing local defaults: ${missing.map(([key]) => key).join(", ")}.`,
    );
  } else {
    console.log("apps/web/.env.local already exists; preserving it.");
  }
}
