const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|^GOOGLE_APPLICATION_CREDENTIALS$/i;
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
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "KUBECONFIG",
  "CLOUDSDK_CONFIG",
  "CLOUDSDK_ACTIVE_CONFIG_NAME",
  "AZURE_CONFIG_DIR",
  "GH_CONFIG_DIR",
  "GLAB_CONFIG_DIR",
  "JENKINS_URL",
];

/**
 * Only OS discovery and nonsecret CLI selectors cross the host boundary; CLIs own their saved credentials.
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
    if (
      key &&
      !SECRET_NAME.test(key) &&
      source[key] &&
      source[key].length <= 4096 &&
      !/[\0\r\n]/.test(source[key])
    ) {
      if (name === "JENKINS_URL") {
        try {
          const url = new URL(source[key]);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            continue;
        } catch {
          continue;
        }
      }
      env[name] = source[key];
    }
  }
  return env;
}
