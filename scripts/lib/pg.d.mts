declare module "pg" {
  export interface QueryResult<Row = unknown> {
    readonly rows: Row[];
    readonly rowCount: number | null;
  }

  export interface Queryable {
    query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  }

  export class Client implements Queryable {
    constructor(options: { connectionString: string; connectionTimeoutMillis?: number });
    connect(): Promise<void>;
    query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }

  const pg: { Client: typeof Client };
  export default pg;
}
