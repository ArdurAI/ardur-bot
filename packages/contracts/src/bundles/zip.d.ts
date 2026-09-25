import type { BundleFile } from "./files.js";
/** Reads bounded single-disk ZIP archives. Extraction never delegates paths to an archiver. */
export declare function readBundleZip(input: Uint8Array): BundleFile[];
