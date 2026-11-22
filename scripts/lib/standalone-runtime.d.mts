export interface StandaloneRuntimeOptions {
  readonly databaseUrl: string;
  readonly authOrigin: string;
  readonly port?: number;
}

export interface StandaloneRuntime {
  readonly origin: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly exitCode: number | null;
  output(): string;
  stop(): Promise<void>;
}

export function standaloneTestEnvironment(
  options: StandaloneRuntimeOptions & { readonly port: number },
): Record<string, string | undefined>;

export function startStandaloneRuntime(
  options: StandaloneRuntimeOptions,
): Promise<StandaloneRuntime>;
