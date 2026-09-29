/**
 * Camada de persistência: PostgreSQL + PostGIS.
 * O schema vive em db/schema.sql e é aplicado na primeira inicialização
 * (idempotente: todos os comandos usam IF NOT EXISTS / ON CONFLICT).
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const schemaCandidates = [
  resolve(here, '../db/schema.sql'),
  resolve(here, '../../db/schema.sql'),
];

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function migrate(): Promise<void> {
  let sql: string | null = null;
  for (const candidate of schemaCandidates) {
    try {
      sql = await readFile(candidate, 'utf8');
      break;
    } catch {
      continue;
    }
  }
  if (sql === null) {
    throw new Error('db/schema.sql não encontrado — verifique o build da imagem.');
  }
  await pool.query(sql);
}

/** Aguarda o banco aceitar conexões (o container sobe antes do Postgres estar pronto). */
export async function waitForDatabase(retries = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === retries) throw error;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
