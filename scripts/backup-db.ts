/**
 * Backup the Railway Postgres database to a local SQL file.
 *
 * Prerequisites:
 * - DATABASE_URL in .env or environment (e.g. from Railway: Postgres → Connect → Postgres connection URL).
 *
 * Uses pg_dump if available; otherwise falls back to a Node-based dump (no PostgreSQL install needed).
 *
 * Usage:
 *   Put DATABASE_URL in .env then run: npm run backup:db
 *   Or with Railway CLI: npx railway run npm run backup:db
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    '[backup-db] DATABASE_URL is not set. Set it from Railway: Postgres service → Connect → Postgres connection URL'
  );
  process.exit(1);
}

/** On Windows, pg_dump is often not on PATH; try common install locations. */
function findPgDump(): string {
  if (process.platform !== 'win32') return 'pg_dump';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pgRoot = join(programFiles, 'PostgreSQL');
  if (!existsSync(pgRoot)) return 'pg_dump';
  try {
    const versions = readdirSync(pgRoot);
    for (const v of versions) {
      const exe = join(pgRoot, v, 'bin', 'pg_dump.exe');
      if (existsSync(exe)) return exe;
    }
  } catch {
    // ignore
  }
  return 'pg_dump';
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = join(process.cwd(), 'backups');
const backupFile = join(backupDir, `claw-db-${timestamp}.sql`);

function escapeSql(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number' && !Number.isNaN(val)) return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  const s = String(val);
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Fallback backup using pg when pg_dump is not installed. */
async function backupWithNode(): Promise<Buffer> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  const lines: string[] = [
    '-- Claw DB backup (Node fallback, no pg_dump)',
    '-- Restore: run scripts/migrate.ts first, then run this file against an empty schema.',
    '',
  ];

  try {
    // Ensure every agent has the default skin so restored backups are self-consistent
    await client.query(`
      INSERT INTO agent_skins (agent_name, skin_id)
      SELECT a.name, 'default'
      FROM agents a
      LEFT JOIN agent_skins s ON s.agent_name = a.name AND s.skin_id = 'default'
      WHERE s.agent_name IS NULL
      ON CONFLICT (agent_name, skin_id) DO NOTHING;
    `);

    const tablesRes = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    const tables = tablesRes.rows.map((r) => r.tablename);

    for (const table of tables) {
      const colsRes = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      const columns = colsRes.rows.map((r) => r.column_name);
      const colsList = columns.map((c) => `"${c}"`).join(', ');
      const res = await client.query(`SELECT ${colsList} FROM "${table}"`);
      lines.push(`-- Table: ${table}`);
      for (const row of res.rows) {
        const values = columns.map((c) => escapeSql((row as Record<string, unknown>)[c]));
        lines.push(`INSERT INTO "${table}" (${colsList}) VALUES (${values.join(', ')});`);
      }
      lines.push('');
    }
  } finally {
    client.release();
    await pool.end();
  }

  return Buffer.from(lines.join('\n'), 'utf8');
}

async function runPgDump(): Promise<Buffer> {
  const pgDumpPath = findPgDump();
  return new Promise((resolve, reject) => {
    const pgDump = spawn(pgDumpPath, [DATABASE_URL, '--no-owner', '--no-acl'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    pgDump.stdout?.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    pgDump.stderr?.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
    });

    pgDump.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(err);
      else reject(err);
    });
    pgDump.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`pg_dump exited with code ${code}: ${stderr.toString('utf8').trim()}`));
    });
  });
}

async function main() {
  await mkdir(backupDir, { recursive: true });
  console.log('[backup-db] Backing up to', backupFile);

  let sql: Buffer;
  try {
    sql = await runPgDump();
    console.log('[backup-db] Using pg_dump.');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      console.log('[backup-db] pg_dump not found, using Node fallback (no PostgreSQL install needed).');
      sql = await backupWithNode();
    } else {
      throw err;
    }
  }

  await writeFile(backupFile, sql);
  console.log('[backup-db] Done. Backup saved to', backupFile);
}

main().catch((err) => {
  console.error('[backup-db]', err.message || err);
  process.exit(1);
});
