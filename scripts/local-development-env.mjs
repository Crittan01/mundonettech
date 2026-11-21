import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
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
const contents = [
  'NEXT_PUBLIC_SITE_URL="http://127.0.0.1:4010"',
  'SITE_URL="http://127.0.0.1:4010"',
  'NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54421"',
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${publishableKey}"`,
  `SUPABASE_SERVICE_ROLE_KEY="${serviceRoleKey}"`,
  'DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54422/postgres"',
  `SESSION_TIMEOUT_SECRET="${secret()}"`,
  `SECURITY_EVENT_PEPPER="${secret()}"`,
  `RECOVERY_CODE_PEPPER="${secret()}"`,
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY="1x00000000000000000000AA"',
  'TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"',
  "",
].join("\n");
const target = path.resolve("apps/web/.env.local");
try {
  writeFileSync(target, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log("Created apps/web/.env.local with local-only credentials and random secrets.");
} catch (error) {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
    console.log("apps/web/.env.local already exists; preserving it.");
  } else throw error;
}
