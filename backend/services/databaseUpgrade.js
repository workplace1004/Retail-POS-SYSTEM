import crypto from 'crypto';
import path from 'path';
import { execFile } from 'child_process';
import { access, copyFile, readFile, readdir, unlink } from 'fs/promises';

/**
 * A database that is kept when a new version is installed still has the previous version's tables
 * and columns. This brings it up to the schema this version was built with: `prisma db push` adds
 * the new tables and columns and leaves the rows that are there.
 *
 * It runs once per schema: the schema's hash is stored in the database itself, so a database
 * restored from an older backup is noticed and updated too.
 *
 * It never deletes data. A change that would (a removed column, a removed table) is refused by
 * `prisma db push`; then nothing is applied, the database stays as it was and the reason is logged.
 * A copy of the file is made before every update, next to the database.
 */

const SETTING_KEY_DB_SCHEMA_HASH = 'db_schema_hash';
const PRE_UPDATE_COPY_MARK = '.pre-update-';
const KEPT_PRE_UPDATE_COPIES = 3;
const DB_PUSH_TIMEOUT_MS = 180000;

function runDbPush(appDir, cliPath, schemaPath) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, 'db', 'push', '--skip-generate', '--schema', schemaPath],
      {
        cwd: appDir,
        env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NO_COLOR: '1' },
        timeout: DB_PUSH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout || ''}\n${stderr || ''}`.trim(), error });
      },
    );
  });
}

async function readStoredSchemaHash(prisma) {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY_DB_SCHEMA_HASH } });
    return row?.value || null;
  } catch {
    // A very old database may not have the settings table yet.
    return null;
  }
}

async function prunePreUpdateCopies(dbPath) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}${PRE_UPDATE_COPY_MARK}`;
  const copies = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - KEPT_PRE_UPDATE_COPIES))) {
    await unlink(path.join(dir, name)).catch(() => {});
  }
}

/**
 * @param {{ prisma: import('@prisma/client').PrismaClient, appDir: string, dbPath: string,
 *   log: (message: string, meta?: unknown) => void }} options
 * @returns {Promise<{ status: 'current' | 'updated' | 'failed', message: string }>}
 */
export async function upgradeDatabaseSchema({ prisma, appDir, dbPath, log }) {
  const schemaPath = path.join(appDir, 'prisma', 'schema.prisma');
  const cliPath = path.join(appDir, 'node_modules', 'prisma', 'build', 'index.js');

  let schemaHash;
  try {
    schemaHash = crypto.createHash('sha256').update(await readFile(schemaPath)).digest('hex');
    await access(cliPath);
  } catch (err) {
    const message = `Database update skipped: ${err?.message || err}`;
    log(message);
    return { status: 'failed', message };
  }

  // Looked up first: the query below creates an empty file when there is none.
  const dbExists = await access(dbPath).then(() => true, () => false);
  if ((await readStoredSchemaHash(prisma)) === schemaHash) {
    return { status: 'current', message: 'Database already matches this version.' };
  }

  log('Database is from another version (or new): checking its tables against this version...');
  await prisma.$disconnect();
  const copyPath = `${dbPath}${PRE_UPDATE_COPY_MARK}${Date.now()}.bak`;
  if (dbExists) {
    try {
      await copyFile(dbPath, copyPath);
    } catch (err) {
      // Without a safety copy the database is left alone.
      const message = `Database update skipped, no safety copy could be made: ${err?.message || err}`;
      log(message);
      return { status: 'failed', message };
    }
  }

  const push = await runDbPush(appDir, cliPath, schemaPath);
  if (!push.ok) {
    const wouldLoseData = /data loss|cannot be executed/i.test(push.output);
    const message = wouldLoseData
      ? 'Database NOT updated: this version changes tables in a way that would delete data. The database is unchanged; some new functions may not work until it is migrated by hand.'
      : 'Database NOT updated: the update tool failed. The database is unchanged.';
    // Nothing was changed, so the copy is the same as the database: no need to keep it.
    if (dbExists) await unlink(copyPath).catch(() => {});
    log(message, { output: push.output.slice(-1500) });
    return { status: 'failed', message };
  }

  const alreadyInSync = /already in sync/i.test(push.output);
  try {
    await prisma.appSetting.upsert({
      where: { key: SETTING_KEY_DB_SCHEMA_HASH },
      create: { key: SETTING_KEY_DB_SCHEMA_HASH, value: schemaHash },
      update: { value: schemaHash },
    });
  } catch (err) {
    log('Database updated, but the version mark could not be stored (the check runs again at the next start).', {
      error: err?.message || String(err),
    });
  }

  if (alreadyInSync) {
    await unlink(copyPath).catch(() => {});
    return { status: 'current', message: 'Database already matches this version.' };
  }
  await prunePreUpdateCopies(dbPath).catch(() => {});
  const message = dbExists
    ? 'Database updated to this version; existing data kept.'
    : 'No database was found: an empty one was created for this version.';
  log(message, { safetyCopy: dbExists ? copyPath : null });
  return { status: 'updated', message };
}
