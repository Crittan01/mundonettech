import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const standaloneAppDir = path.join(appDir, ".next", "standalone", "apps", "web");
const serverEntry = path.join(standaloneAppDir, "server.js");

if (!existsSync(serverEntry)) {
  throw new Error(`Expected Next.js standalone server entrypoint at ${serverEntry}.`);
}

const staticSource = path.join(appDir, ".next", "static");
const staticTarget = path.join(standaloneAppDir, ".next", "static");
if (!existsSync(staticSource)) {
  throw new Error(`Expected compiled client assets at ${staticSource}.`);
}
cpSync(staticSource, staticTarget, { recursive: true, force: true });

const publicSource = path.join(appDir, "public");
if (existsSync(publicSource)) {
  cpSync(publicSource, path.join(standaloneAppDir, "public"), { recursive: true, force: true });
}
