import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { captureApiRequestContext, currentApiBase, selectedSpaceId } from "./api";
import { dispatchClient } from "./dispatch";
import { t } from "./i18n";

export async function exportRunEvidence(runId: string) {
  // Paired-device RPC has no authenticated HTTP archive transport yet.
  if (await dispatchClient.loadHome())
    throw new Error(t("The export could not finish; try again."));
  const spaceId = selectedSpaceId();
  const { apiBase, headers } = await captureApiRequestContext();
  const query = new URLSearchParams(spaceId ? { spaceId } : {});
  const file = new File(
    Paths.cache,
    `ardur-evidence-${encodeURIComponent(runId)}-${Date.now()}.tar.gz`,
  );
  try {
    await File.downloadFileAsync(
      `${apiBase}/api/evidence/runs/${encodeURIComponent(runId)}?${query}`,
      file,
      { headers },
    );
    if (spaceId !== selectedSpaceId() || apiBase !== currentApiBase())
      throw new Error(t("The export could not finish; try again."));
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/gzip",
      UTI: "org.gnu.gnu-zip-archive",
    });
  } finally {
    if (file.exists) file.delete();
  }
}
