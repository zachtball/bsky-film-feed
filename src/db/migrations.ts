import { Kysely, Migration, MigrationProvider } from 'kysely'
import { DatabaseSchema } from './schema'

const migrations: Record<string, Migration> = {}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<DatabaseSchema>) {
    await db.schema
      .createTable('post')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('cid', 'varchar', (col) => col.notNull())
      .addColumn('first_indexed', 'bigint', (col) => col.notNull())
      .addColumn('score', 'real', (col) => col.notNull())
      .addColumn('last_scored', 'bigint', (col) => col.notNull())
      .addColumn('mod', 'integer', (col) => col.notNull())
      .addColumn('needs_eval', 'boolean', (col) =>
        col.notNull().defaultTo(false),
      )
      .execute()
    await db.schema
      .createTable('sub_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'bigint', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<DatabaseSchema>) {
    await db.schema.dropTable('post').execute()
    await db.schema.dropTable('sub_state').execute()
  },
}
