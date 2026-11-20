import { spawnSync } from "node:child_process";

import pg from "pg";

function localStatus() {
  const runtime = spawnSync("podman", ["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
    encoding: "utf8",
  });
  if (runtime.status !== 0 || !runtime.stdout.trim()) {
    throw new Error("Rootless Podman socket is unavailable.");
  }

  const status = spawnSync("pnpm", ["exec", "supabase", "status", "-o", "env", "--workdir", "."], {
    encoding: "utf8",
    env: { ...process.env, DOCKER_HOST: `unix://${runtime.stdout.trim()}` },
  });
  if (status.status !== 0) throw new Error("Local Supabase services are not running.");
  return status.stdout;
}

function variable(status, name) {
  return status.match(new RegExp(`^${name}="(.*)"$`, "m"))?.[1];
}

async function expectOk(name, url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}.`);
  console.log(`${name}: HTTP ${response.status}.`);
}

async function expectRestDenied(roleLabel, apiUrl, key, tableName) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const rest = await fetch(`${apiUrl}/rest/v1/${tableName}?select=*`, { headers });
  const restBody = await rest.text();
  if (![401, 403].includes(rest.status) || !restBody.includes("42501")) {
    throw new Error(
      `PostgREST (${roleLabel}) must deny ${tableName} with SQLSTATE 42501; received ${rest.status}: ${restBody}`,
    );
  }
  console.log(
    `PostgREST ${tableName} (${roleLabel}): HTTP ${rest.status}, SQLSTATE 42501 (denied).`,
  );
}

const status = localStatus();
const apiUrl = variable(status, "API_URL") ?? "http://127.0.0.1:54421";
const anonKey =
  variable(status, "ANON_KEY") ??
  variable(status, "PUBLISHABLE_KEY") ??
  variable(status, "SUPABASE_ANON_KEY");
const serviceRoleKey =
  variable(status, "SERVICE_ROLE_KEY") ??
  variable(status, "SECRET_KEY") ??
  variable(status, "SUPABASE_SERVICE_ROLE_KEY");
if (!anonKey) throw new Error("Local publishable API key is unavailable.");
if (!serviceRoleKey) throw new Error("Local service role API key is unavailable.");

const databaseUrl =
  process.env.DATABASE_URL ??
  variable(status, "DB_URL") ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const database = new pg.Client({ connectionString: databaseUrl });
await database.connect();
await database.query("NOTIFY pgrst, 'reload schema'");
await database.end();
await new Promise((resolve) => setTimeout(resolve, 1_000));

await expectRestDenied("anon", apiUrl, anonKey, "AdminUser");
await expectRestDenied("anon", apiUrl, anonKey, "IntegrationCredential");
await expectRestDenied("service_role", apiUrl, serviceRoleKey, "AdminUser");
await expectRestDenied("service_role", apiUrl, serviceRoleKey, "IntegrationCredential");

await expectOk("Supabase Auth", `${apiUrl}/auth/v1/health`, {
  apikey: anonKey,
  Authorization: `Bearer ${anonKey}`,
});
await expectOk("Supabase Studio", "http://127.0.0.1:54423");
await expectOk("Mailpit", "http://127.0.0.1:54424");
