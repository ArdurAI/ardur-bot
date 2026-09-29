import { serviceProcessEnvironment } from "@ardurbot/core/node/service-secrets";
import { type AppEnv, loadEnv } from "./env.js";

/**
 * Resolves API config. A secrets file named by ARDURBOT_SECRETS_FILE is read onto
 * the object passed to loadEnv and is never copied onto process.env. With no
 * secrets file, this is the process environment, so `pnpm dev` is unchanged.
 */
export function loadAppEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return loadEnv(serviceProcessEnvironment(source));
}
