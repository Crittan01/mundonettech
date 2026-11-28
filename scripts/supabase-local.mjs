import { spawn, spawnSync } from "node:child_process";

const command = process.argv[2];
const supported = new Set(["start", "status", "stop"]);

if (!command || !supported.has(command)) {
  console.error("Usage: node scripts/supabase-local.mjs <start|status|stop>");
  process.exit(1);
}

const runtime = spawnSync("podman", ["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
  encoding: "utf8",
});

if (runtime.status !== 0 || !runtime.stdout.trim()) {
  console.error("A rootless Podman socket is required for the local Supabase stack.");
  process.exit(runtime.status ?? 1);
}

const containerFilter = "name=_mundonettech";

if (command === "start") {
  const existing = spawnSync("podman", ["ps", "-aq", "--filter", containerFilter], {
    encoding: "utf8",
  });
  const containerIds = existing.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (containerIds.length > 0) {
    const dbStart = spawnSync("podman", ["start", "supabase_db_mundonettech"], {
      stdio: "inherit",
    });
    if (dbStart.status !== 0) process.exit(dbStart.status ?? 1);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = spawnSync(
        "podman",
        ["exec", "supabase_db_mundonettech", "pg_isready", "-U", "postgres", "-d", "postgres"],
        { stdio: "ignore" },
      );
      if (ready.status === 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    const startAll = spawnSync("podman", ["start", ...containerIds], { stdio: "inherit" });
    if (startAll.status !== 0) process.exit(startAll.status ?? 1);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const statusCheck = spawnSync("pnpm", ["exec", "supabase", "status", "--workdir", "."], {
        env: { ...process.env, DOCKER_HOST: `unix://${runtime.stdout.trim()}` },
        stdio: "ignore",
      });
      if (statusCheck.status === 0) process.exit(0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    process.exit(0);
  }
}

const args = ["exec", "supabase", command, "--workdir", "."];
if (command === "stop") args.push("--project-id", "mundonettech");

const child = spawn("pnpm", args, {
  env: {
    ...process.env,
    DOCKER_HOST: `unix://${runtime.stdout.trim()}`,
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Supabase CLI terminated by ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
