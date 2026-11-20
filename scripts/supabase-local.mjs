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
