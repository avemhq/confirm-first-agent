import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL } from './schema'

export type Db = DatabaseSync
export type Row = Record<string, unknown>

/** Open (or create) a SQLite database and apply the schema. Use ':memory:' for tests and evals. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA_SQL)
  return db
}

/**
 * Run fn inside one write transaction (BEGIN IMMEDIATE takes the write lock up front,
 * so read-check-write sequences cannot interleave). Nested calls join the outer transaction.
 */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// node:sqlite returns null-prototype objects; copy them into plain objects so they can be
// serialized everywhere (React Server Components reject null prototypes).
const plain = (row: unknown) => ({ ...(row as Row) })

export function all<T = Row>(db: Db, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params).map(plain) as T[]
}

export function get<T = Row>(db: Db, sql: string, ...params: (string | number | null)[]): T | undefined {
  const row = db.prepare(sql).get(...params)
  return row === undefined ? undefined : (plain(row) as T)
}

export function run(db: Db, sql: string, ...params: (string | number | null)[]): number {
  return Number(db.prepare(sql).run(...params).changes)
}

/** Hash of every business table: proves "nothing changed" in evals. */
export function businessStateHash(db: Db, hash: (s: string) => string): string {
  const parts = ['tasks', 'documents', 'memberships', 'projects'].map((t) =>
    JSON.stringify(all(db, `SELECT * FROM ${t} ORDER BY 1, 2`)),
  )
  return hash(parts.join('|'))
}
