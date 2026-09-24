import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { rpc } from "./api";

/** The authenticated export endpoint records the audit before creating any local file. */
export async function exportCommandRun(runId: string) {
  const result = await rpc<{ text: string; filename: string }>("commands/export", { runId });
  const file = new File(Paths.cache, `command-${Date.now()}.log`);
  file.create({ overwrite: true });
  try {
    file.write(result.text);
    await Sharing.shareAsync(file.uri, { mimeType: "text/plain", UTI: "public.plain-text" });
  } finally {
    file.delete();
  }
}
