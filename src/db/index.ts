import { Pool } from 'pg'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { DatabaseSchema } from './schema'
import { migrationProvider } from './migrations'
import fs from 'node:fs'
import path from 'node:path'

export type Database = Kysely<DatabaseSchema>

export const createDb = (connectionString: string): Database => {
  const caCertPath = path.resolve(__dirname, '../assets/ca-certificate.crt')
  const ca = fs.readFileSync(caCertPath).toString()

  const sslConfig = {
    rejectUnauthorized: true,
    ca,
  }

  const pool = new Pool({
    connectionString,
    ssl: sslConfig,
  })

  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool,
    }),
  })
}

export const migrateToLatest = async (db: Database) => {
  const migrator = new Migrator({ db, provider: migrationProvider })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}
