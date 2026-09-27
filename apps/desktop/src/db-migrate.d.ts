/**
 * The desktop build writes `db-migrate.js` as a bundle of the database package's SQL
 * migrator with only `pg` left external, so the packaged app does not carry that package.
 */
export {
  applicationDatabaseReady,
  applySqlMigrationsToDatabase,
  ensureApplicationDatabase,
  sqlMigrationsReady,
} from "@ardurbot/db/migrate";
