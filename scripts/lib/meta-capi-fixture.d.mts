import type { IncomingHttpHeaders } from "node:http";

export interface MetaCapiFixtureCall {
  method: string;
  path: string;
  query: string;
  rawBody: string;
  body: {
    test_event_code?: string;
    data: Array<{
      event_id: string;
      custom_data: {
        order_id: string;
        value: number;
        num_items: number;
        contents: Array<{ id: string; quantity: number }>;
      };
      user_data: Record<string, unknown>;
    }>;
  };
  authorization: string | null;
  headers: IncomingHttpHeaders;
  sequence: number;
}

export interface MetaCapiFixtureResult {
  destroy?: boolean;
  delayMs?: number;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export function startMetaCapiFixture(options?: {
  port?: number;
  onEvent?: (
    call: MetaCapiFixtureCall,
    sequence: number,
  ) => MetaCapiFixtureResult | undefined | Promise<MetaCapiFixtureResult | undefined>;
}): Promise<{
  origin: string;
  calls: MetaCapiFixtureCall[];
  stop(): Promise<void>;
}>;
