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

const status = localStatus();
const apiUrl = variable(status, "API_URL") ?? "http://127.0.0.1:54421";
const apiKey =
  variable(status, "ANON_KEY") ??
  variable(status, "PUBLISHABLE_KEY") ??
  variable(status, "SUPABASE_ANON_KEY");
if (!apiKey) throw new Error("Local publishable API key is unavailable.");

const database = new pg.Client({
  connectionString: "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
});
await database.connect();
await database.query("NOTIFY pgrst, 'reload schema'");
await database.end();
await new Promise((resolve) => setTimeout(resolve, 1_000));

const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
const rest = await fetch(`${apiUrl}/rest/v1/AdminUser?select=id`, { headers });
const restBody = await rest.text();
if (![401, 403].includes(rest.status) || !restBody.includes("42501")) {
  throw new Error(
    `PostgREST must deny AdminUser with SQLSTATE 42501; received ${rest.status}: ${restBody}`,
  );
}
console.log(`PostgREST AdminUser: HTTP ${rest.status}, SQLSTATE 42501 (denied).`);

await expectOk("Supabase Auth", `${apiUrl}/auth/v1/health`, headers);
await expectOk("Supabase Studio", "http://127.0.0.1:54423");
await expectOk("Mailpit", "http://127.0.0.1:54424");
