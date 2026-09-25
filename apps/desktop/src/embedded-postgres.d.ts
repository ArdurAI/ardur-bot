declare module "embedded-postgres" {
  interface EmbeddedPostgresConstructorOptions {
    databaseDir?: string;
    port?: number;
    user?: string;
    password?: string;
    persistent?: boolean;
    authMethod?: string;
    postgresFlags?: string[];
    onLog?: (message: string) => void;
    onError?: (error: unknown) => void;
  }

  export default class EmbeddedPostgres {
    constructor(options?: EmbeddedPostgresConstructorOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
}
