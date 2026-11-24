import {
  CredentialForbiddenError,
  CredentialNotFoundError,
} from "../../packages/integrations/dist/index.js";

const providerPattern = /^[a-z][a-z0-9._-]{0,99}$/;

export function withSystemProviderVault(vault) {
  return {
    ...vault,
    forSystemProvider(provider) {
      if (!providerPattern.test(provider)) throw new TypeError("Invalid system provider.");
      return {
        async list(options = { limit: 100 }) {
          if (options.includeRevoked === true) throw new CredentialForbiddenError();
          const limit = options.limit ?? 100;
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new RangeError("limit must be an integer between 1 and 100.");
          }
          const result = await vault.list({ includeRevoked: false, limit: 100 });
          return {
            items: result.items
              .filter((item) => item.provider === provider && !item.revokedAt)
              .slice(0, limit),
            nextCursor: null,
          };
        },
        async reveal(id) {
          const result = await vault.list({ includeRevoked: true, limit: 100 });
          const record = result.items.find((item) => item.id === id);
          if (!record || record.provider !== provider || record.revokedAt) {
            throw new CredentialNotFoundError();
          }
          return vault.reveal(id);
        },
      };
    },
  };
}
