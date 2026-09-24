import { ComparisonSchema } from "@ardurbot/contracts";
import { rpc } from "./api";

export async function loadComparisons() {
  return ComparisonSchema.array().parse(await rpc("comparisons/list", {}));
}
