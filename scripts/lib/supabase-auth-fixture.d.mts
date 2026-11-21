export interface SupabaseFixtureSession {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly expires_at: number;
  readonly token_type: "bearer";
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly factors: ReadonlyArray<{
      readonly id: string;
      readonly factor_type: "totp";
      readonly status: "verified";
    }>;
  };
}

export function createSupabaseFixtureSession(options: {
  subject: string;
  email: string;
  factorId: string;
  aal?: "aal1" | "aal2";
  mfaAgeSeconds?: number;
  hasVerifiedFactor?: boolean;
  now?: Date;
}): SupabaseFixtureSession;

export function encodeSupabaseFixtureCookie(session: SupabaseFixtureSession): string;

export function startSupabaseAuthFixture(options?: { host?: string; port?: number }): Promise<{
  origin: string;
  stop(): Promise<void>;
}>;
