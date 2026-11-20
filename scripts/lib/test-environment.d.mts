export interface SafeDatabaseTarget {
  hostname: string;
  port: string;
  database: string;
}

export interface SafeSupabaseTarget {
  hostname: string;
  port: string;
}

export function isLoopbackHostname(hostname: string): boolean;
export function assertSafeTestProcess(env?: Readonly<Record<string, string | undefined>>): void;
export function assertSafeTestSupabaseUrl(supabaseUrl: string): SafeSupabaseTarget;
export function assertSafeTestDatabase(
  databaseUrl: string,
  options?: { ci?: boolean },
): SafeDatabaseTarget;
export function assertSafeTestEnvironment(
  env?: Readonly<Record<string, string | undefined>>,
  databaseUrl?: string,
): SafeDatabaseTarget;
