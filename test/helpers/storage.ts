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
 * What it deliberately does **not** reproduce, because those are host
 * behaviours rather than this plugin's:
 *
 * - the core-table denylist (`request_logs`, `api_keys`, …) and its
 *   string-literal/comment scanner;
 * - the `plugin_migrations` ledger, which the host owns and which survives
 *   restarts;
 * - parameter narrowing, `listTables`, `dropAll`, `orphanTables`.
 *
 * Those are covered in the monorepo, against the real store. If the expansion
 * rule below ever disagrees with the host's, these tests go green while the
 * installed plugin addresses tables that do not exist — which is exactly why the
 * rule is a storage contract that cannot change without a migration, and why it
 * is restated here verbatim rather than approximated.
 */

/** The plugin's own id, from `omni-plugin.json`. Table names are built from it. */
const PLUGIN_ID = "pokemon";

/** `{{name}}`, matched without trimming — same as the host: `{{ name }}` is an error. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The host's `<name>` pattern: `^[a-z][a-z0-9_]{0,31}$`. */
const TABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** Expands `{{name}}` to `"plugin_pokemon_<name>"`, quoted as the host quotes it. */
function expand(sql: string): string {
  return sql.replace(PLACEHOLDER, (_match, name: string) => {
    if (!TABLE_NAME.test(name)) {
      throw new Error(
        `plugin table placeholder ${JSON.stringify(name)} must match ${TABLE_NAME.source}`,
      );
    }
    return `"plugin_${PLUGIN_ID}_${name}"`;
  });
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
