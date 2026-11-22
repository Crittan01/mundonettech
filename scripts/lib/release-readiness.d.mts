export interface ReleaseCheck {
  readonly name: string;
  readonly passed: boolean;
}

export function validateReleaseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ReleaseCheck[];

export function verifyReleaseHttp(
  target: string,
  fetchImplementation?: typeof fetch,
): Promise<ReleaseCheck[]>;
