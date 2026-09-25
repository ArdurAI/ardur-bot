import type { BundleUploadSchema } from "@ardurbot/contracts";
import type * as z from "zod";
import type { BundleFile } from "../../desktop/src/extensions/files.js";
import { validateBundleFiles } from "../../desktop/src/extensions/files.js";

/** Uploads use the same bounded path validation as native bundle installation. */
export function uploadedBundle(files: z.infer<typeof BundleUploadSchema>): BundleFile[] {
  const result = files.map((file) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))
      throw new Error("A bundle file is not valid base64.");
    return {
      path: file.path,
      bytes: Buffer.from(file.content, "base64"),
      executable: file.executable,
    };
  });
  validateBundleFiles(result);
  return result;
}
export function encodedBundle(files: BundleFile[]) {
  return files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.bytes).toString("base64"),
    executable: file.executable,
  }));
}
