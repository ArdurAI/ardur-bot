import { rpc, selectedSpaceId } from "../../lib/rpc";
import { MemoryPage } from "./MemoryPage";

export default function MemorySettings() {
  const spaceId = selectedSpaceId();
  return (
    <MemoryPage
      key={spaceId}
      proposeImport={(text) =>
        rpc.memory.propose(
          { intent: "import", text, requestId: crypto.randomUUID() },
          { context: { spaceId } },
        )
      }
      proposeEdit={(text) =>
        rpc.memory.propose(
          { intent: "edit", text, requestId: crypto.randomUUID() },
          { context: { spaceId } },
        )
      }
    />
  );
}
