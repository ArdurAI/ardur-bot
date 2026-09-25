import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AskBlock } from "../AskCard";
import { AskCard } from "../AskCard";
import { I18nBootstrap } from "../I18nBootstrap";
import "../../styles.css";

function ApprovalFixture() {
  const [block, setBlock] = useState<AskBlock>({
    kind: "ask",
    text: `'gh' 'issue' 'create' '--body' '${"x".repeat(3000)}' '--title' '${"y".repeat(3000)} **tail** <b>literal</b> $(false)'`,
    detail:
      "Identity: fixture-account\nWorkspace: fixture-workspace\nWorking directory: '/workspace'\n[redacted]",
    approvalEffectId: "fixture-effect",
    preformatted: true,
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  });
  return (
    <main className="bg-background p-8">
      <AskCard
        block={block}
        canAnswer
        onAnswer={async (answer) => setBlock({ ...block, answer, status: "answered" })}
      />
    </main>
  );
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(
    <I18nBootstrap>
      <ApprovalFixture />
    </I18nBootstrap>,
  );
}
