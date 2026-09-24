const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$/i;
const OS_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "SHELL",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HOMEBREW_PREFIX",
];

/**
 * Only OS discovery inputs cross the host boundary; CLIs own their saved credentials.
 * Plain JavaScript also lets the packaged desktop load this without a TypeScript runtime.
 * @param {Record<string, string | undefined>} source
 * @param {string} platform
 */
export function filterHostEnvironment(source, platform = "posix") {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const name of OS_VARIABLES) {
    const key =
      platform === "win32"
        ? Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase())
        : name;
    if (key && !SECRET_NAME.test(key) && source[key]) env[name] = source[key];
  }
  return env;
}
