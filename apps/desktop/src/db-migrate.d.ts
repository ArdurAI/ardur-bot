/**
 * The desktop build writes `db-migrate.js` as a bundle of the database package's SQL
 * migrator with only `pg` left external, so the packaged app does not carry that package.
 */
export {
  applySqlMigrationsToDatabase,
  ensureApplicationDatabase,
} from "@ardurbot/db/migrate";
