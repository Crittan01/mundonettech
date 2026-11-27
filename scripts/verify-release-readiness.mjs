import {
  readValidatedGpgPassphraseFile,
  validateGpgPassphraseValue,
} from "./lib/recovery-config.mjs";
import { validateReleaseConfiguration, verifyReleaseHttp } from "./lib/release-readiness.mjs";

const targetEnvironment = process.env.RELEASE_ENVIRONMENT;
if (targetEnvironment !== "STG" && targetEnvironment !== "PRD") {
  throw new Error("Set RELEASE_ENVIRONMENT=STG or RELEASE_ENVIRONMENT=PRD explicitly.");
}
if (!process.env.RELEASE_TARGET_URL) {
  throw new Error("Set RELEASE_TARGET_URL to the HTTPS deployment being verified.");
}

const configuration = validateReleaseConfiguration(process.env);
const passphraseFile = process.env.BACKUP_GPG_PASSPHRASE_FILE?.trim();
if (passphraseFile) {
  let filePassed = false;
  try {
    const value = await readValidatedGpgPassphraseFile(passphraseFile);
    validateGpgPassphraseValue(value);
    filePassed = !/^REPLACE_WITH_/i.test(value);
  } catch {
    filePassed = false;
  }
  configuration.push({ name: "release.backupGpgPassphraseFile", passed: filePassed });
}
const failedConfiguration = configuration.filter((check) => !check.passed);
for (const check of configuration) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}
if (failedConfiguration.length > 0) {
  throw new Error(
    `${targetEnvironment} configuration has ${failedConfiguration.length} unmet release checks; no deployment was promoted.`,
  );
}

const httpChecks = await verifyReleaseHttp(process.env.RELEASE_TARGET_URL);
for (const check of httpChecks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}
const failedHttp = httpChecks.filter((check) => !check.passed);
if (failedHttp.length > 0) {
  throw new Error(
    `${targetEnvironment} has ${failedHttp.length} failed HTTP checks; no deployment was promoted.`,
  );
}
console.log(
  `${targetEnvironment} release readiness passed ${configuration.length + httpChecks.length} checks. Human promotion approval remains mandatory.`,
);
