import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, Transaction } from 'kysely';
import { Pool, types } from 'pg';
import { AppConfig } from '../config/app-config';
import type { DB } from './db.types';

// int8 (counts/sums) → number; numeric → number; date → 'YYYY-MM-DD' string (no TZ shifting).
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));
types.setTypeParser(1082, (v) => v);

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
export type DbOrTx = Kysely<DB> | Transaction<DB>;

export const KYSELY = Symbol('KYSELY');
export const InjectDb = () => Inject(KYSELY);

export function createKysely(connectionString: string, max = 10): Kysely<DB> {
  const pool = new Pool({
    connectionString,
    max,
    application_name: 'rove-backend',
  });
  pool.on('error', (err) => new Logger('Database').error(`Idle client error: ${err.message}`));
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

@Injectable()
class DbLifecycle implements OnModuleDestroy {
  constructor(@InjectDb() private readonly db: Db) {}
  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createKysely(config.get('DATABASE_URL'), config.get('DB_POOL_MAX')),
    },
    DbLifecycle,
  ],
  exports: [KYSELY],
})
export class DatabaseModule {}

/** Postgres error helpers. */
export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}
export function pgConstraint(err: unknown): string | undefined {
  return (err as { constraint?: string })?.constraint;
}
