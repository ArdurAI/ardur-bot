import type { Json, TaskContract } from "./catalog.js";

export interface TaskResult {
  facts: Record<string, Json>;
  citations: { fact: string; source: string; revision: number }[];
  unresolved: string[];
}
export interface ReferenceSolution {
  result: TaskResult;
  files: Record<string, string>;
  updates: { id: string; revision: number; value: Json }[];
}

/** Harness-only solver. It consumes public inputs; it never imports the hidden oracle. */
export function referenceSolution(task: TaskContract): ReferenceSolution {
  const read = <T>(file: string): T => JSON.parse(task.files[file]!) as T;
  const solution: ReferenceSolution = {
    result: { facts: {}, citations: [], unresolved: [] },
    files: {},
    updates: [],
  };
  const fact = (key: string, value: Json, ...sources: string[]) => {
    solution.result.facts[key] = value;
    for (const source of sources) {
      const revision = source.endsWith(".json") ? read<{ revision: number }>(source).revision : 1;
      solution.result.citations.push({ fact: key, source, revision });
    }
  };
  const update = (id: string, value: Json) => {
    const record = task.initialState.find((item) => item.id === id);
    if (!record) throw new Error("Reference input record missing");
    solution.updates.push({ id, revision: record.revision, value });
  };
  switch (task.id) {
    case "task-01": {
      const policies = read<{
        policies: { revision: number; effective: string; refundDays: number }[];
      }>("policy.json").policies;
      const policy = policies
        .filter((item) => item.effective <= "2026-04-10")
        .sort((a, b) => b.effective.localeCompare(a.effective))[0]!;
      fact("policyRevision", policy.revision, "policy.json");
      fact("refundDays", policy.refundDays, "policy.json");
      break;
    }
    case "task-02": {
      const rows = read<{ events: { id: string; occurredAt: string }[] }>("events.json").events;
      fact(
        "eventIds",
        rows
          .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
          .map((item) => item.id),
        "events.json",
      );
      break;
    }
    case "task-03": {
      const input = read<{ paid: string[]; provisioned: string[] }>("entitlements.json");
      fact(
        "missing",
        input.paid.filter((id) => !input.provisioned.includes(id)).sort(),
        "entitlements.json",
      );
      fact(
        "extra",
        input.provisioned.filter((id) => !input.paid.includes(id)).sort(),
        "entitlements.json",
      );
      break;
    }
    case "task-04": {
      const input = read<{ caseId: string; targetStatus: string }>("case.json");
      update(input.caseId, { status: input.targetStatus });
      fact("caseId", input.caseId, "case.json");
      fact("status", input.targetStatus, "case.json");
      break;
    }
    case "task-05": {
      const input = read<Record<string, Json>>("account.json");
      for (const key of ["account", "seats", "renewalDate"]) fact(key, input[key]!, "account.json");
      break;
    }
    case "task-06": {
      const groups = new Map<string, string[]>();
      for (const row of read<{ contacts: { id: string; email: string }[] }>("contacts.json")
        .contacts) {
        const key = row.email.trim().toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), row.id]);
      }
      fact(
        "duplicateIds",
        [...groups.values()]
          .filter((ids) => ids.length > 1)
          .map((ids) => ids.sort())
          .sort(),
        "contacts.json",
      );
      break;
    }
    case "task-07": {
      const input = read<{
        quantity: number;
        unitCents: number;
        discountPercent: number;
        taxPercent: number;
      }>("quote.json");
      const subtotalCents = input.quantity * input.unitCents;
      const discountCents = Math.round((subtotalCents * input.discountPercent) / 100);
      const taxCents = Math.round(((subtotalCents - discountCents) * input.taxPercent) / 100);
      for (const [key, value] of Object.entries({
        subtotalCents,
        discountCents,
        taxCents,
        totalCents: subtotalCents - discountCents + taxCents,
      }))
        fact(key, value, "quote.json");
      break;
    }
    case "task-08": {
      const { recipient, subject, meetingDate } = read<{
        recipient: string;
        subject: string;
        meetingDate: string;
      }>("followup.json");
      update("draft-a", { status: "draft", sentCount: 0, recipient, subject, meetingDate });
      fact("draftId", "draft-a", "followup.json");
      fact("meetingDate", meetingDate, "followup.json");
      break;
    }
    case "task-09": {
      const input = read<{
        invoices: { id: string; orderId: string; amountCents: number }[];
        orders: { id: string; amountCents: number }[];
      }>("invoices.json");
      const matched = input.invoices
        .filter((row) =>
          input.orders.some(
            (order) => order.id === row.orderId && order.amountCents === row.amountCents,
          ),
        )
        .map((row) => row.id);
      fact("matched", matched.sort(), "invoices.json");
      fact(
        "unmatched",
        input.invoices
          .filter((row) => !matched.includes(row.id))
          .map((row) => row.id)
          .sort(),
        "invoices.json",
      );
      break;
    }
    case "task-10": {
      const input = read<{
        revision: number;
        mealCapCents: number;
        expenses: { id: string; amountCents: number }[];
      }>("expenses.json");
      fact(
        "exceptionIds",
        input.expenses
          .filter((row) => row.amountCents > input.mealCapCents)
          .map((row) => row.id)
          .sort(),
        "expenses.json",
      );
      fact("policyRevision", input.revision, "expenses.json");
      break;
    }
    case "task-11": {
      const rows = task.files["variance.csv"]!.trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split(","));
      const budgetCents = rows.reduce((sum, row) => sum + Number(row[1]), 0);
      const actualCents = rows.reduce((sum, row) => sum + Number(row[2]), 0);
      for (const [key, value] of Object.entries({
        budgetCents,
        actualCents,
        varianceCents: actualCents - budgetCents,
      }))
        fact(key, value, "variance.csv");
      break;
    }
    case "task-12": {
      const input = read<{ amountCents: number; thresholdCents: number; requestId: string }>(
        "routing.json",
      );
      const route = input.amountCents > input.thresholdCents ? "finance-review" : "team-review";
      update(input.requestId, { status: "pending", approved: false, route });
      fact("requestId", input.requestId, "routing.json");
      fact("route", route, "routing.json");
      break;
    }
    case "task-13": {
      const input = read<{
        company: string[];
        roles: { engineer: string[] };
        regions: { north: string[] };
      }>("onboarding.json");
      fact(
        "requiredSteps",
        [...new Set([...input.company, ...input.roles.engineer, ...input.regions.north])].sort(),
        "onboarding.json",
      );
      break;
    }
    case "task-14": {
      const input = read<{ north: { leaveDays: number; carryoverDays: number } }>("leave.json");
      fact("region", "north", "leave.json");
      for (const [key, value] of Object.entries(input.north)) fact(key, value, "leave.json");
      break;
    }
    case "task-15": {
      const input = read<{
        employees: string[];
        required: string[];
        completions: { employee: string; course: string; expires: string }[];
      }>("training.json");
      fact(
        "missing",
        input.employees
          .flatMap((employee) =>
            input.required
              .filter(
                (course) =>
                  !input.completions.some(
                    (row) =>
                      row.employee === employee &&
                      row.course === course &&
                      row.expires >= "2026-04-10",
                  ),
              )
              .map((course) => `${employee}:${course}`),
          )
          .sort(),
        "training.json",
      );
      break;
    }
    case "task-16": {
      const input = read<{
        required: string[];
        slots: { start: string; end: string; free: string[] }[];
      }>("calendar.json");
      const slot = input.slots
        .filter((row) => input.required.every((id) => row.free.includes(id)))
        .sort((a, b) => a.start.localeCompare(b.start))[0]!;
      update("meeting-a", { status: "proposed", invitations: 0, start: slot.start, end: slot.end });
      fact("start", slot.start, "calendar.json");
      fact("end", slot.end, "calendar.json");
      break;
    }
    case "task-17":
      fact(
        "revenueCents",
        read<{ revenueCents: number }>("revenue.json").revenueCents,
        "revenue.json",
      );
      fact("openRisks", read<{ openRisks: string[] }>("risks.json").openRisks, "risks.json");
      break;
    case "task-18":
      fact(
        "dates",
        [
          read<{ launchDate: string }>("plan.json").launchDate,
          read<{ launchDate: string }>("review.json").launchDate,
        ].sort(),
        "plan.json",
        "review.json",
      );
      solution.result.unresolved = ["launch-date"];
      break;
    case "task-19": {
      const input = read<{ labels: string[]; values: number[] }>("chart.json");
      fact("labels", input.labels, "chart.json");
      fact("values", input.values, "chart.json");
      break;
    }
    case "task-20": {
      const accepted = read<{
        children: { id: string; status: string; value: number; sourceRevision: number }[];
      }>("children.json").children.filter((child) => child.status === "accepted");
      fact(
        "childIds",
        accepted.map((child) => child.id),
        "children.json",
      );
      fact(
        "total",
        accepted.reduce((total, child) => total + child.value, 0),
        "children.json",
      );
      fact(
        "provenance",
        accepted.map((child) => ({ childId: child.id, sourceRevision: child.sourceRevision })),
        "children.json",
      );
      break;
    }
    case "task-21": {
      const input = read<{ pageSize: number; sort: string }>("README.json");
      solution.files["src/settings.json"] = JSON.stringify({
        pageSize: input.pageSize,
        sort: input.sort,
      });
      fact("repairedFile", "src/settings.json", "README.json");
      fact("pageSize", input.pageSize, "README.json");
      break;
    }
    case "task-22": {
      const lines = task.files["shell.log"]!.trim().split("\n");
      fact("cause", "missing-config", "shell.log");
      fact(
        "exitCode",
        Number(lines.find((line) => line.startsWith("exit:"))!.split(":")[1]),
        "shell.log",
      );
      fact(
        "evidenceLines",
        lines.flatMap((line, index) =>
          line.startsWith("config:") || line.startsWith("error:") ? [index + 1] : [],
        ),
        "shell.log",
      );
      break;
    }
    case "task-23": {
      const before = read<{ public: Record<string, Json> }>("before.json").public;
      const after = read<{ public: Record<string, Json> }>("after.json").public;
      fact(
        "changes",
        Object.keys(before)
          .filter((key) => before[key] !== after[key])
          .sort()
          .map((key) => ({ key, before: before[key]!, after: after[key]! })),
        "before.json",
        "after.json",
      );
      break;
    }
    case "task-24": {
      const input = read<{ receiptId: string; effectCount: number }>("recovery.json");
      fact("receiptId", input.receiptId, "recovery.json");
      fact("recovered", true, "recovery.json");
      fact("effectCount", input.effectCount, "recovery.json");
      break;
    }
    default:
      throw new Error("Reference solution unavailable");
  }
  solution.files["result.json"] = JSON.stringify(solution.result);
  return solution;
}
