import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { IntegrationEnvironment } from "../packages/db/dist/index.js";
import {
  CredentialDecryptionError,
  CredentialKeyRingError,
  createCredentialKeyRing,
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  loadCredentialKeyRing,
  reencryptIntegrationCredential,
} from "../packages/integrations/dist/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyOne = randomBytes(32).toString("base64");
const keyTwo = randomBytes(32).toString("base64");

function ring(environment = IntegrationEnvironment.LOCAL, activeVersion = 2) {
  return createCredentialKeyRing({
    environment,
    activeVersion,
    serializedKeys: JSON.stringify({ 1: keyOne, 2: keyTwo }),
  });
}

function seal(options = {}) {
  return encryptIntegrationCredential({
    credentialId: randomUUID(),
    environment: IntegrationEnvironment.LOCAL,
    plaintext: encoder.encode('{"accessToken":"test-only-secret"}'),
    ring: ring(),
    ...options,
  });
}

describe("F0.3 — AES-256-GCM credential cryptography", () => {
  it("encrypts with a fresh 96-bit nonce, authenticates, and round-trips bytes", () => {
    const plaintext = encoder.encode('{"accessToken":"test-only-secret"}');
    const first = seal({ plaintext });
    const second = seal({ credentialId: first.credentialId, plaintext });

    assert.equal(first.keyVersion, 2);
    assert.equal(first.nonce.length, 12);
    assert.equal(first.authTag.length, 16);
    assert.equal(first.ciphertext.length, plaintext.length);
    assert.notDeepEqual(first.nonce, second.nonce);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
    assert.equal(
      decoder.decode(decryptIntegrationCredential(first, ring())),
      decoder.decode(plaintext),
    );
    assert.equal(Buffer.from(first.ciphertext).includes(plaintext), false);
  });

  it("rejects tampering with ciphertext, nonce, tag, identity, and environment", () => {
    const sealed = seal();
    const mutations = [
      { ...sealed, ciphertext: Buffer.from(sealed.ciphertext).fill(0) },
      { ...sealed, nonce: Buffer.from(sealed.nonce).fill(0) },
      { ...sealed, authTag: Buffer.from(sealed.authTag).fill(0) },
      { ...sealed, credentialId: randomUUID() },
      { ...sealed, environment: IntegrationEnvironment.STG },
    ];

    for (const mutation of mutations) {
      assert.throws(
        () => decryptIntegrationCredential(mutation, ring()),
        CredentialDecryptionError,
      );
    }
  });

  it("isolates key rings by environment and rejects unknown or incorrect keys", () => {
    const sealed = seal();
    const staging = ring(IntegrationEnvironment.STG);
    const incorrect = createCredentialKeyRing({
      environment: IntegrationEnvironment.LOCAL,
      activeVersion: 2,
      serializedKeys: JSON.stringify({ 2: randomBytes(32).toString("base64") }),
    });

    assert.throws(() => decryptIntegrationCredential(sealed, staging), CredentialDecryptionError);
    assert.throws(() => decryptIntegrationCredential(sealed, incorrect), CredentialDecryptionError);
    assert.throws(
      () => seal({ environment: IntegrationEnvironment.STG }),
      CredentialDecryptionError,
    );
  });

  it("decrypts old versions and reencrypts only with the active key and a new nonce", () => {
    const versionOne = createCredentialKeyRing({
      environment: IntegrationEnvironment.LOCAL,
      activeVersion: 1,
      serializedKeys: JSON.stringify({ 1: keyOne, 2: keyTwo }),
    });
    const plaintext = encoder.encode("rotation-payload");
    const original = seal({ plaintext, ring: versionOne });
    const rotated = reencryptIntegrationCredential(original, ring());

    assert.equal(original.keyVersion, 1);
    assert.equal(rotated.keyVersion, 2);
    assert.notDeepEqual(original.nonce, rotated.nonce);
    assert.deepEqual(
      Buffer.from(decryptIntegrationCredential(original, ring())),
      Buffer.from(plaintext),
    );
    assert.deepEqual(
      Buffer.from(decryptIntegrationCredential(rotated, ring())),
      Buffer.from(plaintext),
    );
  });

  it("validates plaintext size, UUIDs, encrypted field lengths, and key versions", () => {
    assert.throws(() => seal({ plaintext: new Uint8Array() }), RangeError);
    assert.throws(() => seal({ plaintext: new Uint8Array(65_537) }), RangeError);
    assert.equal(seal({ plaintext: new Uint8Array(65_536).fill(7) }).ciphertext.length, 65_536);
    assert.throws(() => seal({ credentialId: "not-a-uuid" }), TypeError);
    assert.throws(
      () => decryptIntegrationCredential({ ...seal(), nonce: new Uint8Array(11) }, ring()),
      CredentialDecryptionError,
    );
    assert.throws(
      () => decryptIntegrationCredential({ ...seal(), authTag: new Uint8Array(15) }, ring()),
      CredentialDecryptionError,
    );
    assert.throws(
      () => decryptIntegrationCredential({ ...seal(), ciphertext: new Uint8Array() }, ring()),
      CredentialDecryptionError,
    );
  });

  it("strictly validates serialized key rings without leaking key material in errors", () => {
    const invalidRings = [
      "not-json",
      "null",
      "[]",
      "{}",
      '{"0":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
      '{"one":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
      '{"1":"short"}',
      '{"1":"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!="}',
      '{"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    ];

    for (const serializedKeys of invalidRings) {
      assert.throws(
        () =>
          createCredentialKeyRing({
            environment: IntegrationEnvironment.LOCAL,
            activeVersion: 2,
            serializedKeys,
          }),
        CredentialKeyRingError,
      );
    }
    for (const activeVersion of [0, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      assert.throws(
        () =>
          createCredentialKeyRing({
            environment: IntegrationEnvironment.LOCAL,
            activeVersion,
            serializedKeys: "{}",
          }),
        CredentialKeyRingError,
      );
    }

    try {
      createCredentialKeyRing({
        environment: IntegrationEnvironment.LOCAL,
        activeVersion: 2,
        serializedKeys: '{"1":"short"}',
      });
      assert.fail("invalid key ring was accepted");
    } catch (error) {
      assert.ok(error instanceof CredentialKeyRingError);
      assert.equal(error.message.includes("short"), false);
    }
  });

  it("loads only the explicitly selected environment from process variables", () => {
    const serializedKeys = JSON.stringify({ 7: keyOne });
    const env = {
      INTEGRATION_CREDENTIAL_KEYS_LOCAL: serializedKeys,
      INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL: "7",
      INTEGRATION_CREDENTIAL_KEYS_STG: serializedKeys,
      INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_STG: "7",
    };

    assert.equal(loadCredentialKeyRing(IntegrationEnvironment.LOCAL, env).activeVersion, 7);
    assert.equal(
      loadCredentialKeyRing(IntegrationEnvironment.STG, env).environment,
      IntegrationEnvironment.STG,
    );
    assert.throws(
      () => loadCredentialKeyRing(IntegrationEnvironment.PRD, env),
      CredentialKeyRingError,
    );
    assert.throws(
      () =>
        loadCredentialKeyRing(IntegrationEnvironment.LOCAL, {
          ...env,
          INTEGRATION_CREDENTIAL_ACTIVE_KEY_VERSION_LOCAL: "0",
        }),
      CredentialKeyRingError,
    );
  });
});
