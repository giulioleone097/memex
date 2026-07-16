export declare const TOMBSTONE_FILE_NAME = "MIGRATED.md";
export interface MigrationResultV1 {
    migrated: boolean;
    from: string;
    to: string;
    entries: number;
    tombstonePath?: string;
}
/**
 * One-time migration of the plugin's previous `~/.openwiki/` storage root
 * (from the `openwiki` distribution) to the current `~/.memex/` root.
 *
 * Branches:
 * - Legacy root missing               -> no-op (`migrated: false`, `entries: 0`).
 * - Legacy root is a symlink          -> `SYMLINK_ESCAPE` (existing confinement error).
 * - Legacy root already tombstoned    -> no-op; a prior run already relocated the data.
 * - New root already holds data       -> `MIGRATION_CONFLICT`; refuses to guess which
 *                                        root is authoritative.
 * - Otherwise                         -> atomic same-filesystem rename, with a
 *                                        copy-then-verify-then-remove fallback across
 *                                        filesystems, followed by a tombstone written
 *                                        into a freshly recreated legacy root.
 */
export declare function runMigration(homeDir: string): Promise<MigrationResultV1>;
