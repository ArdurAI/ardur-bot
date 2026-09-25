export declare const BUNDLE_MAX_BYTES: number;
export declare const BUNDLE_MAX_FILES = 10000;
export declare const DOCUMENT_MAX_BYTES: number;
export interface BundleFile {
  path: string;
  bytes: Uint8Array;
  executable?: boolean;
}
/** Use portable names so a bundle has the same containment rules on every OS. */
export declare function bundlePath(value: string): string;
export declare function validateBundleFiles(files: readonly BundleFile[]): void;
/** The caller supplies a fresh, private staging directory, never an existing install. */
export declare function writeBundleFiles(
  directory: string,
  files: readonly BundleFile[],
): Promise<void>;
/** Native folder selection grants a snapshot, not continuing access to symlink targets. */
export declare function readBundleFolder(directory: string): Promise<BundleFile[]>;
export declare function bundleDocument(
  files: readonly BundleFile[],
  name: string,
): string | undefined;
