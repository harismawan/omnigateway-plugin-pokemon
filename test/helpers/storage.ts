import { Database } from "bun:sqlite";
import type { PluginMigration, PluginStorage } from "@omnigateway/plugin-api/define";

/**
 * A `PluginStorage` over an in-memory SQLite database.
 *
 * **This mirrors the host's behaviour; it does not share it.** The real
 * implementation lives in OmniGateway's `@omni/store`, which is an internal,
 * unpublished package: an external plugin cannot import it, so it cannot test
 * against the code that will actually run its SQL. This helper reimplements the
 * two parts of that contract a plugin's own tests depend on — `{{name}}`
 * expanding to `plugin_<id>_<name>`, and one transaction per migration — and
 * nothing else. It is the closest an external plugin can currently get.
 *
 * It reproduces the host's **refusals** as well, and that is not tidiness. A
 * shim that only expands names accepts SQL the host rejects, so a migration
 * written against it passes every test here and then fails at boot — where the
 * plugin is skipped and the operator sees it only in a log line. The refusals
 * are the part a plugin author most needs to find out about early, so they are
 * the part most worth mirroring: the core-table denylist, and the connection
 * statements a plugin may not issue because the handle belongs to the gateway.
 *
 * What it deliberately does **not** reproduce, because those are the host's own
 * bookkeeping rather than anything this plugin's SQL can trip over:
 *
 * - the `plugin_migrations` ledger, which survives restarts;
 * - parameter narrowing, `listTables`, `dropAll`, `orphanTables`;
 * - the literal/comment scanner that keeps the denylist from firing on a core
 *   name stored as *data*. Its absence makes this shim stricter than the host,
 *   never looser, which is the safe direction for a mirror to be wrong in.
 *
 * If the rules below ever disagree with the host's, these tests go green while
 * the installed plugin addresses tables that do not exist. That is why they are
 * restated verbatim rather than approximated, and why `CORE_TABLES` is copied
 * whole: a name added there and not here is a migration that passes and then
 * cannot boot.
 */

/** The plugin's own id, from `omni-plugin.json`. Table names are built from it. */
const PLUGIN_ID = "pokemon";

/** `{{name}}`, matched without trimming — same as the host: `{{ name }}` is an error. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The host's `<name>` pattern: `^[a-z][a-z0-9_]{0,31}$`. */
const TABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The host's core tables, copied whole.
 *
 * Copied rather than referenced because the package holding it is unpublished.
 * A name added there and not here is a migration that passes every test in this
 * repository and is then refused at boot as a fatal migration failure — the
 * plugin is skipped and it shows up only in the gateway's log.
 *
 * Note `settings`, `credentials` and `migrations` are ordinary words: a *column*
 * or alias by any of these names is refused too. That is the host's behaviour and
 * not a bug in this mirror.
 */
const CORE_TABLES = [
  "api_keys",
  "credential_health",
  "credentials",
  "migrations",
  "plugin_migrations",
  "quota_samples",
  "quota_windows",
  "request_bodies",
  "request_logs",
  "settings",
  "usage_daily",
  "usage_rollup",
  "virtual_models",
] as const;

/** Case-insensitive, because SQLite matches identifiers that way and so must this. */
const CORE_TABLE_REFERENCE = new RegExp(`\\b(?:${CORE_TABLES.join("|")})\\b`, "i");

/**
 * Statements that reconfigure the connection rather than touch a table.
 *
 * Refused because in a real gateway the handle is shared: `PRAGMA journal_mode`
 * would take the whole process out of WAL, not just this plugin. In this shim the
 * database is private and nothing would break — which is exactly why it has to be
 * refused here too, or a plugin would learn the habit somewhere it is harmless
 * and ship it somewhere it is not.
 */
const CONNECTION_STATEMENT = /^\s*(pragma|attach|detach|vacuum)\b/i;

/** Expands `{{name}}` to `"plugin_pokemon_<name>"`, quoted as the host quotes it. */
function expand(sql: string): string {
  const expanded = sql.replace(PLACEHOLDER, (_match, name: string) => {
    if (!TABLE_NAME.test(name)) {
      throw new Error(
        `plugin table placeholder ${JSON.stringify(name)} must match ${TABLE_NAME.source}`,
      );
    }
    return `"plugin_${PLUGIN_ID}_${name}"`;
  });

  const connection = CONNECTION_STATEMENT.exec(expanded);
  if (connection !== null) {
    throw new Error(`plugin sql may not ${connection[1]?.toUpperCase()}: the handle is the host's`);
  }

  const core = CORE_TABLE_REFERENCE.exec(expanded);
  if (core !== null) {
    throw new Error(`plugin sql may not reference the core table ${core[0]}`);
  }
  return expanded;
}

export type TestStorage = PluginStorage & {
  /**
   * Applies migrations in version order, **one transaction each** — the host's
   * rule, and not a detail. A single batch transaction would let a failure at
   * migration 5 silently revert 1 through 4 on every later boot, so a plugin
   * whose migrations are only ever exercised inside one transaction has never
   * been tested the way it will run.
   */
  migrate(migrations: readonly PluginMigration[]): void;
  /** Table names this plugin owns, as SQLite stores them (unquoted, sorted). */
  listTables(): string[];
  close(): void;
};

export function createTestStorage(): TestStorage {
  const db = new Database(":memory:");
  // Versions already applied, held here because this helper has no
  // `plugin_migrations` ledger of its own. One database per test, so an
  // in-memory set is equivalent to the host's table for the span it covers.
  const applied = new Set<number>();

  return {
    migrate(migrations: readonly PluginMigration[]): void {
      // Sorted on a copy: the caller's array is the plugin's own export.
      const ordered = [...migrations].sort((a, b) => a.version - b.version);
      for (const migration of ordered) {
        if (applied.has(migration.version)) continue;
        const sql = expand(migration.sql);
        db.transaction(() => {
          db.run(sql);
        })();
        applied.add(migration.version);
      }
    },

    run(sql: string, params?: readonly unknown[]): void {
      db.run(expand(sql), toBindings(params));
    },

    all<T>(sql: string, params?: readonly unknown[]): T[] {
      return db.prepare(expand(sql)).all(...toBindings(params)) as T[];
    },

    get<T>(sql: string, params?: readonly unknown[]): T | null {
      const row = db.prepare(expand(sql)).get(...toBindings(params));
      return row === null || row === undefined ? null : (row as T);
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    listTables(): string[] {
      const prefix = `plugin_${PLUGIN_ID}_`;
      return db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((r) => r.name)
        .filter((name) => name.startsWith(prefix));
    },

    close(): void {
      db.close();
    },
  };
}

/** What SQLite can bind. Narrowed at the boundary, as the host narrows it. */
type Binding = string | number | bigint | boolean | null | Uint8Array;

function toBinding(value: unknown, index: number): Binding {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(`plugin sql parameter ${index} is not a bindable value`);
}

const toBindings = (params: readonly unknown[] | undefined): Binding[] =>
  (params ?? []).map(toBinding);
