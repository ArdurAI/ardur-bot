import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { LocalityPolicy, ModelDestination } from "@ardurbot/contracts";
import {
  DelegationSnapshotSchema,
  LocalityPolicySchema,
  RuntimePinError,
  runtimePinProblem,
} from "@ardurbot/contracts";
import { allowsModelDestination, modelDestination } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { LOCAL_PROVIDER_ID, localBaseUrl } from "./pi-local-provider.js";
import { modelsForRequest } from "./pi-runtime.js";

/** Use the same endpoint metadata as model dispatch, including custom connections. */
export function destinationForModel(model: AgentRunModel): ModelDestination {
  if (model.provider === "scripted") return { host: "localhost", local: true };
  const concrete = modelsForRequest({ model }, model.provider).getModel(model.provider, model.id);
  return modelDestination(
    model.baseUrl ?? (model.provider === LOCAL_PROVIDER_ID ? localBaseUrl() : concrete?.baseUrl),
  );
}
export function modelLocalityAllowed(policies: unknown[], model: AgentRunModel): boolean {
  const destination = destinationForModel(model);
  return policies.every((value) => {
    const policy = LocalityPolicySchema.safeParse(
      value ?? ({ mode: "any" } satisfies LocalityPolicy),
    );
    return policy.success && allowsModelDestination(policy.data, destination);
  });
}

/** Validate the admitted endpoint and return the remaining completion allowance. */
export async function enforceDelegationDestination(
  prisma: PrismaClient,
  id: string,
  model: AgentRunModel,
) {
  const row = await prisma.delegation.findUniqueOrThrow({ where: { id } });
  const snapshot = DelegationSnapshotSchema.parse(row.snapshot);
  const requester = await prisma.bot.findFirstOrThrow({
    where: { id: row.requesterBotId, spaceId: row.spaceId, userId: row.userId },
  });
  const destination = destinationForModel(model);
  if (
    destination.host !== snapshot.destination.host ||
    destination.local !== snapshot.destination.local ||
    !modelLocalityAllowed([requester.allowedModelDestinations], model)
  )
    throw new RuntimePinError(
      runtimePinProblem(
        snapshot.pin,
        "locality-denied",
        "This destination changed or is outside the requester policy; review the pin before delegating again.",
      ),
    );
  return Math.max(1, row.reservedTokens - row.usedTokens);
}
