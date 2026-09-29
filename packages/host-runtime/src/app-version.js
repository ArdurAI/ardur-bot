// The root package.json version is the app version; bundlers inline the file.
import rootPackage from "../../../package.json" with { type: "json" };

export const APP_VERSION = rootPackage.version;
