import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  ConnectorCatalogItem,
  JobPublisher,
  MemoryStore,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import {
  computerControlExpireJobKey,
  messagingDeliverJob,
  routineJobKey,
  routineWakeupJob,
  runContinueJob,
  runJobKey,
} from "@ardurbot/adapter-kit";
import type {
  CloudAgentConnection,
  ComposioProvider,
  ComputerExecutionLease,
  ConnectorRegistry,
  DelegationResolver,
  EncryptedSecretStore,
  IntegrationProviderSettings,
  MemoryProviderResolver,
  PiOAuthLogins,
  RemoteConnectorDependencies,
} from "@ardurbot/adapters";
import {
  AnthropicOAuthUnavailableError,
  acquireComputerExecutionLease,
  applyTeachingDesktopInput,
  archiveBot,
  assertLocalImportOwner,
  autoReviewConfigurationWarning,
  buildMcpCredentialBlob,
  buildModelConnectPlaintext,
  bumpMcpServerRevision,
  CodexConnections,
  ComputerBusyError,
  cancelComputerRunWork,
  checkpointAndRecordComputerWorkspace,
  clearInactiveUserComputerControl,
  computerSupportsUpdate,
  computerUpdateView,
  createVoiceProvider,
  defaultCatalogModelId,
  deletePushToken,
  deploymentAutoReviewDefault,
  deploymentHostLabel,
  destroyBot,
  displayBotWorkspacePath,
  enqueueLearningReview,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  isAutoReviewCheckerConfigured,
  isComputerScreenUnavailable,
  isSandboxGoneError,
  isScratchpadStatus,
  kubernetesContexts,
  LocalImportInvalidFolderError,
  LocalImportService,
  listPiCatalog,
  listScratchpadItems,
  loadPushToken,
  lockMcpServerRevision,
  McpOAuthAttemptReplacedError,
  McpOAuthBroker,
  MissingComputerProviderError,
  mapScratchpadItem,
  modelCredentialDto,
  NATIVE_HOST_OWNER_MESSAGE,
  nativeHostOwner,
  nativeRuntimeAvailability,
  ollamaCatalog,
  ollamaCatalogPlaceholder,
  ollamaErrorMessage,
  pickReusableConnection,
  planLiveConnectionSync,
  prepareApiInstall,
  prepareGraphqlInstall,
  probeOpenAiCompatibleModels,
  proposeMemoryIntent,
  provisionComputer,
  pullOllamaModel,
  queueComputerUpdate,
  releaseComputerExecutionLease,
  replaceComputer,
  resolveAutoReviewChecker,
  resolveBotWorkspacePath,
  sanitizeComposioError,
  savePushToken,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  scriptedCatalogEntry,
  serializeModelSecret,
  takeoverLeaseMs,
  toComputerRef,
  touchRunningComputer,
  verifyMcpInstall,
} from "@ardurbot/adapters";
import type { Auth } from "@ardurbot/auth";
import type { Actor, ComputerStatus, Me, SpaceNavigation } from "@ardurbot/contracts";
import {
  HOST_MOVE_UNAVAILABLE_MESSAGE,
  IntegrationManifestSchema,
  IntegrationProviderIdSchema,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  usableModelId,
} from "@ardurbot/contracts";
import { LOCAL_IMPORT_INVALID_FOLDER_CODE } from "@ardurbot/contracts/local-import";
import { appContract } from "@ardurbot/contracts/rpc";
import {
  ACTIVE_RUN_STATUSES,
  AttachmentValidationError,
  connectionOverview,
  containsSecret,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
} from "@ardurbot/core";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import {
  appendEventInTransaction,
  BotSectionNameConflictError,
  CannotDeleteDefaultSpaceError,
  CannotDeleteLastSpaceError,
  CannotDeleteSpaceAsNonOwnerError,
  claimEmptySpaceDeletionForMember,
  createExternalConversationRepos,
  createGroupRepos,
  createRepos,
  createSpaceForMember,
  createThreadMessageInTransaction,
  deleteEmptySpaceForMember,
  deleteUnreferencedCredentialSecret,
  findDefaultModelCredential,
  findDefaultVoiceCredential,
  findModelCredential,
  findSpaceMemoryConfig,
  formatMessagingLinkCode,
  getUserPreferences,
  InvalidSpaceNameError,
  IsolationError,
  issueMessagingLinkCode,
  listDelegations,
  lockOwnedGroup,
  newestModelCredentialOrder,
  newestVoiceCredentialOrder,
  Prisma,
  parseComputerMode,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  requestCancel,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
  SpaceLimitError,
  SpaceNotEmptyError,
  SpaceNotFoundError,
  selectSpaceModelPreference,
  selectSpaceVoicePreference,
  touchGroupUpdatedAt,
  updateUserPreferences,
} from "@ardurbot/db";
import { redactMcpArguments } from "@ardurbot/host-runtime/mcp-diagnostics";
import { getLogger } from "@ardurbot/logging";
import type { MemoryService } from "@ardurbot/memory";
import type { Router } from "@orpc/server";
import { implement, ORPCError } from "@orpc/server";
import { createAccountService } from "./account.js";
import { exportDownload } from "./account-export.js";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "./agent-secrets.js";
import { createAgentSkillsService } from "./agent-skills.js";
import { aiConsentStatus, allowAiConsent } from "./ai-consent.js";
import { createOwnedArtifact, getOwnedArtifact, getSpaceArtifact } from "./artifacts.js";
import { boardCall, createBoard } from "./board.js";
import { botModelPinUpdate } from "./bot-model-pin.js";
import { botProfileLabelsChanged, commitBotUpdate } from "./bot-update.js";
import { createCapabilitySettings } from "./capability-settings.js";
import { createCommandRoutes } from "./command-routes.js";
import { createComparisons } from "./comparisons.js";
import { releaseMaintenanceControl } from "./computer-maintenance.js";
import {
  computerEngineInfo,
  listComputerConnections,
  saveComputerConnection,
  validateComputerConfiguration,
} from "./computer-settings.js";
import {
  executionBlocksUserTakeover,
  resolveBusyBotName,
  toComputerStatus,
} from "./computer-status.js";
import { createContextService } from "./context.js";
import type { RouterContext } from "./customization-routes.js";
import { createCustomizationRoutes } from "./customization-routes.js";
import { dashboardNow, routineOverview, usageSummary } from "./dashboard.js";
import { getModelDestinations, setModelDestinations } from "./delegation-policy.js";
import { listSpaceFeatures, setSpaceFeature } from "./features.js";
import {
  fleetBotPreference,
  fleetDiscover,
  fleetList,
  savePlacement,
  testFleetTarget,
} from "./fleet.js";
import type { HostBridge } from "./host-bridge.js";
import { sourceHostStatus } from "./host-status.js";
import { createIdeChanges } from "./ide-changes.js";
import { createIdeFiles } from "./ide-files.js";
import { searchIntegrationCatalog } from "./integration-catalog.js";
import { connectionDto, IntegrationConnections } from "./integration-connections.js";
import { createLearningService } from "./learning.js";
import { saveImportedServerCredentials } from "./local-import-credentials.js";
import type { LocalImportRequests } from "./local-import-requests.js";
import { buildMcpUpdateMaterial } from "./mcp-material.js";
import { mcpServerDto } from "./mcp-server-dto.js";
import { changeGitMemoryLocation } from "./memory-git-location.js";
import { changeMemoryLocation } from "./memory-location.js";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  serializeSpaceMemoryConfig,
  testMemoryProviderConnection,
  updateMemoryProviderDefaultScope,
} from "./memory-provider-config.js";
import { memoryContext, memoryRpc } from "./memory-routes.js";
import { createChannelPairing } from "./messaging-dispatch.js";
import { notificationActivity } from "./notification-activity.js";
import { ollamaConnection, ollamaStatus } from "./ollama.js";
import {
  chooseFocus,
  dismissFocus,
  markAppConnected,
  promptFocus,
  startOnboarding,
} from "./onboarding.js";
import { createRemoteDevices } from "./remote-devices.js";
import { routineHistory } from "./routine-history.js";
import { listSpaceRuns } from "./runs.js";
import { addScreenProxyCapability } from "./screen-proxy.js";
import { querySpaceSearch } from "./search.js";
import { withSerializableRetry } from "./serializable-retry.js";
import type { UpdaterProxyConfig } from "./server-update.js";
import {
  applyServerUpdate,
  checkServerUpdate,
  readServerUpdateStatus,
  UpdaterProxyError,
} from "./server-update.js";
import { createSystemSettings } from "./system/settings.js";
import { assertTeachingSendAllowed, createTaughtSkillsService } from "./taught-skills.js";
import { acceptTeamTask, teamBoard } from "./team.js";
import type { createTerminalRoutes } from "./terminal-routes.js";
import { guardComputerTakeover } from "./terminal-takeover.js";
import {
  isPeerRun,
  loadMessagePage,
  shouldForwardPeerThreadEvent,
} from "./thread-message-pages.js";
import {
  reactToThreadMessage,
  resolveThreadTarget,
  sendThreadMessage,
  setThreadUnreadState,
  stopThreadRuns,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";
import { deleteUploadedFile, listUploadedFiles } from "./uploaded-files.js";
import {
  disconnectVoiceCredential,
  listVoiceCatalog,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  persistVoiceCredential,
  prepareVoice,
  toVoiceCredential,
  toVoiceStatus,
  voiceContext,
} from "./voice.js";

const MAX_COMPUTER_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const THREAD_MESSAGE_PAGE_SIZE = 100;

async function reconcilePendingConnections(
  prisma: PrismaClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  connectedProviders: string[],
): Promise<void> {
  const connectedProviderKeys = new Set(
    connectedProviders.map((provider) => provider.trim().toLowerCase()),
  );
  const rows = (
    await prisma.connection.findMany({
      where: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId,
        status: { in: ["pending", "connected"] },
      },
      select: { id: true, provider: true, displayName: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((row: { provider: string }) =>
    connectedProviderKeys.has(row.provider.trim().toLowerCase()),
  );
  const sync = planLiveConnectionSync(rows, connectedProviders);
  const updates = [
    ...(sync.connectIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.connectIds },
              spaceId: owner.spaceId,
              userId: owner.userId,
              status: "pending",
            },
            data: { status: "connected" },
          }),
        ]
      : []),
    ...(sync.revokeIds.length > 0
      ? [
          prisma.connection.updateMany({
            where: {
              id: { in: sync.revokeIds },
              spaceId: owner.spaceId,
              userId: owner.userId,
              status: "pending",
            },
            data: { status: "revoked" },
          }),
        ]
      : []),
  ];
  if (updates.length > 0) await prisma.$transaction(updates);
}

/** Serialize begin/revoke for one user+provider so slug-wide remote deletes cannot race a new connect. */

function isAmbiguousRemoteRevokeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|network|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

/** True when a connector failed before issuing any remote DELETE. */
function isRemoteRevokePreDeleteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "remoteRevokePreDelete" in error &&
      (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete === true,
  );
}

function shouldRestoreLocalAfterRemoteRevokeFailure(error: unknown): boolean {
  // Pre-delete list/network failures never reached DELETE — always keep retry state.
  // Post-delete timeouts stay ambiguous and leave the row revoked.
  return isRemoteRevokePreDeleteFailure(error) || !isAmbiguousRemoteRevokeFailure(error);
}

/**
 * Concrete account ids still referenced by active local rows. When any row still
 * only has the provider slug (or no ref), orphan cleanup must not run — a sibling
 * may have created its remote account before persisting the concrete id.
 */
function concreteKeepAccountIds(
  refs: Array<string | null | undefined>,
  provider: string,
): { keepIds: string[]; canRevokeUnreferenced: boolean } {
  const keepIds: string[] = [];
  let canRevokeUnreferenced = true;
  for (const ref of refs) {
    const value = ref?.trim();
    if (!value || value === provider) {
      canRevokeUnreferenced = false;
      continue;
    }
    keepIds.push(value);
  }
  return { keepIds, canRevokeUnreferenced };
}

async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: Pick<Actor, "spaceId" | "userId">,
  connectorId: string,
  provider: string,
): Promise<void> {
  // Avoid NUL separators in the lock key; text params may truncate at a zero byte and break begin.
  const scope = `space:${owner.spaceId}|user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
}

function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

function mcpAssignmentDto(row: {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: unknown;
  needsReview?: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    serverId: row.serverId,
    allowAllTools: false,
    needsReview: row.needsReview === true || row.allowAllTools,
    allowedTools:
      !row.needsReview && !row.allowAllTools && Array.isArray(row.allowedTools)
        ? row.allowedTools.filter((item): item is string => typeof item === "string")
        : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface RouterDeps {
  runtime?: AgentRuntime;
  resolveComparisonPin?: DelegationResolver;
  hostBridge?: HostBridge;
  localImportRequests?: LocalImportRequests;
  terminals?: ReturnType<typeof createTerminalRoutes>;
  cloudAgent?: CloudAgentConnection | null;
  prisma: PrismaClient;
  events: ThreadEvents;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryDocuments?: MemoryService;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  secrets: EncryptedSecretStore;
  oauthLogins: PiOAuthLogins;
  integrationSettings?: IntegrationProviderSettings;
  composio?: ComposioProvider;
  mcpOAuth?: McpOAuthBroker;
  integrationConnections?: IntegrationConnections;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  artifacts: ArtifactStore;
  dataDir: string;
  /** Present when the external messaging surface is enabled. */
  messaging?: { enabled: boolean; providers: string[]; openSignup: boolean };
  env: {
    deploymentKind?: "source" | "packaged";
    desktopStackToken?: string;
    agentRuntime: string;
    teamChatJudgeProvider?: string;
    teamChatJudgeModel?: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelKey?: string;
    webOrigin: string;
    privacyPolicyUrl?: string;
    screenProxySecret: string;
    sandboxProvider: string;
    sandboxSupervisorUrl?: string;
    sandboxSupervisorToken?: string;
    gitSha?: string;
    updaterUrl?: string;
    updaterToken?: string;
    imageTag?: string;
    integrationsCatalogUrl?: string;
    mcpStdioEnabled?: boolean;
    mcpStdioAllowedCommands?: string[];
  };
}

/** Bound for one provider sandbox destroy during Space deletion. Providers may
 * ignore the request abort signal, so without a deadline a hung destroy would
 * keep the deletion claim renewed forever and block stale-claim recovery. */
const SPACE_TEARDOWN_TIMEOUT_MS = 120_000;

function spaceTeardownTimeoutMs(): number {
  const override = Number(process.env.SPACE_TEARDOWN_TIMEOUT_MS ?? "");
  return Number.isFinite(override) && override > 0 ? override : SPACE_TEARDOWN_TIMEOUT_MS;
}

/** Surface a Space deletion race as a retryable conflict instead of a generic failure. */
function mapSpaceLifecycleError(error: unknown): unknown {
  if (error instanceof SpaceDeletionInProgressError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  return error;
}

export function createRouter(deps: RouterDeps): Router<typeof appContract, RouterContext> {
  const board = createBoard(deps);
  const comparisons = createComparisons({
    prisma: deps.prisma,
    jobs: deps.jobs,
    resolvePin:
      deps.resolveComparisonPin ??
      (async () => {
        throw new ORPCError("SERVICE_UNAVAILABLE");
      }),
  });
  const nativeConnections = new CodexConnections();
  const os = implement(appContract).$context<{
    actor: Actor | null;
    signal?: AbortSignal;
    authSessionId?: string;
    authHeaders?: Headers;
    origin?: string;
  }>();
  const channelPairing = createChannelPairing(deps);
  const remoteDevices = createRemoteDevices({ ...deps, publicUrl: deps.env.webOrigin });
  const account = createAccountService({ ...deps, remoteDevices });
  const repos = createRepos(deps.prisma);
  const onboardingDeps = { prisma: deps.prisma, events: deps.events, connectors: deps.connectors };
  const mcpOAuth = deps.mcpOAuth ?? new McpOAuthBroker(deps.prisma, deps.secrets);
  const integrations =
    deps.integrationConnections ??
    new IntegrationConnections(
      deps.prisma,
      mcpOAuth,
      deps.secrets,
      deps.env.webOrigin,
      deps.remoteConnectors,
      {
        stdioEnabled: deps.env.mcpStdioEnabled,
        allowedCommands: deps.env.mcpStdioAllowedCommands,
        hostMcp: deps.hostBridge,
      },
      async (actor) =>
        (
          (await sourceHostStatus(deps.prisma, actor.userId, deps.env.sandboxProvider)) ??
          (await deps.hostBridge?.status(actor.userId))
        )?.health?.integrations ?? [],
    );
  const groupRepos = createGroupRepos(deps.prisma);
  const taughtSkills = createTaughtSkillsService({
    memoryDocuments: deps.memoryDocuments,
    prisma: deps.prisma,
    events: deps.events,
    jobs: deps.jobs,
    sandbox: deps.sandbox,
    home: deps.home,
    dataDir: deps.dataDir,
  });
  const learning = createLearningService(deps);
  const agentSkills = createAgentSkillsService(deps.prisma, deps.memoryDocuments);
  const localImport = new LocalImportService({
    prisma: deps.prisma,
    documents: deps.memoryDocuments!,
  });
  const importOwner = ({ spaceId, userId }: Actor) => ({ spaceId, userId });

  const authed = os.use(async ({ context, next }) => {
    if (!context.actor) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, actor: context.actor } });
  });

  const systemSettings = createSystemSettings(deps.prisma);
  const commands = createCommandRoutes(deps);
  const ide = createIdeFiles(deps);
  const ideChanges = createIdeChanges(deps, ide);
  return os.router({
    ...createCustomizationRoutes(deps),
    account: {
      get: authed.account.get.handler(({ context }) => account.get(context.actor)),
      updateProfile: authed.account.updateProfile.handler(({ context, input }) =>
        account.updateProfile(context.actor, input),
      ),
      updateInstructions: authed.account.updateInstructions.handler(({ context, input }) =>
        account.updateInstructions(context.actor, input),
      ),
      setTrustedDevices: authed.account.setTrustedDevices.handler(({ context, input }) =>
        account.setTrustedDevices(context.actor, input.required),
      ),
      approveDevice: authed.account.approveDevice.handler(({ context, input }) =>
        account.approveDevice(context.actor, input.id),
      ),
      localDevices: authed.account.localDevices.handler(({ context }) =>
        account.localDevices(context.actor),
      ),
      disconnectDevice: authed.account.disconnectDevice.handler(({ context, input }) =>
        account.disconnectDevice(context.actor, input),
      ),
      sessions: authed.account.sessions.handler(({ context }) =>
        account.sessions.list(context.actor.userId, context.authHeaders ?? new Headers()),
      ),
      revokeSession: authed.account.revokeSession.handler(({ context, input }) =>
        account.sessions.revoke(
          context.actor.userId,
          context.authHeaders ?? new Headers(),
          input.id,
        ),
      ),
      revokeOtherSessions: authed.account.revokeOtherSessions.handler(({ context }) =>
        account.sessions.revokeOthers(context.actor.userId, context.authHeaders ?? new Headers()),
      ),
    },
    system: {
      dispatch: authed.system.dispatch.handler(({ context }) => systemSettings.get(context.actor)),
      setDispatch: authed.system.setDispatch.handler(({ context, input }) =>
        systemSettings.set(context.actor, input.enabled),
      ),
    },
    channelPairing: {
      installations: authed.channelPairing.installations.handler(({ context }) =>
        channelPairing.installations(context.actor),
      ),
      configure: authed.channelPairing.configure.handler(({ context, input }) =>
        channelPairing.configure(context.actor, input),
      ),
      start: authed.channelPairing.start.handler(({ context, input }) =>
        channelPairing.start(context.actor, input),
      ),
    },
    ide: {
      roots: authed.ide.roots.handler(({ context }) => ide.roots(context.actor)),
      list: authed.ide.list.handler(({ context, input }) =>
        ide.list(context.actor, input, context.signal),
      ),
      read: authed.ide.read.handler(({ context, input }) =>
        ide.read(context.actor, input, context.signal),
      ),
      save: authed.ide.save.handler(({ context, input }) =>
        ide.save(context.actor, input, context.signal),
      ),
      changes: authed.ide.changes.handler(({ context, input }) => ideChanges(context.actor, input)),
    },
    terminal: {
      close: authed.terminal.close.handler(
        ({ context, input }) =>
          deps.terminals?.close(context.actor, input) ?? Promise.resolve({ ok: true as const }),
      ),
      available: authed.terminal.available.handler(
        ({ context, input }) =>
          deps.terminals?.available(context.actor, input) ?? Promise.resolve({ available: false }),
      ),
      ticket: authed.terminal.ticket.handler(({ context, input }) => {
        if (!deps.terminals) throw new ORPCError("FORBIDDEN");
        return deps.terminals.ticket(context.actor, input, context.authSessionId, context.origin);
      }),
    },
    devices: {
      list: authed.devices.list.handler(({ context }) => remoteDevices.list(context.actor)),
      rename: authed.devices.rename.handler(({ context, input }) =>
        remoteDevices.rename(context.actor, input),
      ),
      revoke: authed.devices.revoke.handler(({ context, input }) =>
        remoteDevices.revoke(context.actor, input),
      ),
    },
    pairing: {
      start: authed.pairing.start.handler(({ context, input }) =>
        remoteDevices.start(context.actor, input),
      ),
      confirm: authed.pairing.confirm.handler(({ context, input }) =>
        remoteDevices.confirm(context.actor, input),
      ),
    },
    commands: {
      list: authed.commands.list.handler(({ context, input }) =>
        commands.list(context.actor, input),
      ),
      open: authed.commands.open.handler(({ context, input }) =>
        commands.open(context.actor, input),
      ),
      export: authed.commands.export.handler(({ context, input }) =>
        commands.export(context.actor, input),
      ),
      share: authed.commands.share.handler(({ context, input }) =>
        commands.share(context.actor, input),
      ),
      rerun: authed.commands.rerun.handler(({ context, input }) =>
        commands.rerun(context.actor, input),
      ),
    },
    aiConsent: {
      status: authed.aiConsent.status.handler(({ context, input }) =>
        aiConsentStatus(deps, context.actor, input),
      ),
      allow: authed.aiConsent.allow.handler(({ context, input }) =>
        allowAiConsent(deps, context.actor, input),
      ),
      revoke: authed.aiConsent.revoke.handler(async ({ context, input }) => {
        await deps.prisma.aiDataConsent.deleteMany({
          where: {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            recipientKey: input.key ?? undefined,
          },
        });
        return aiConsentStatus(deps, context.actor);
      }),
    },
    health: os.health.handler(async () => ({ ok: true as const, version: "0.1.0" })),
    me: authed.me.handler(async ({ context }): Promise<Me> => meDto(deps, context.actor)),
    preferences: {
      get: authed.preferences.get.handler(({ context }) =>
        getUserPreferences(deps.prisma, context.actor.userId),
      ),
      update: authed.preferences.update.handler(async ({ context, input }) => {
        const { avatarStyle, ...patch } = input;
        if (avatarStyle !== undefined)
          await deps.prisma.user.update({
            where: { id: context.actor.userId },
            data: { avatarStyle },
          });
        const preferences = await updateUserPreferences(deps.prisma, context.actor.userId, patch);
        return { ...(await meDto(deps, context.actor)), preferences };
      }),
    },
    spaces: {
      list: authed.spaces.list.handler(async ({ context }) =>
        spaceNavigationDto(deps, context.actor, repos, groupRepos),
      ),
      create: authed.spaces.create.handler(async ({ context, input }) => {
        let space: { id: string; name: string };
        try {
          space = await createSpaceForMember(deps.prisma, {
            currentSpaceId: context.actor.spaceId,
            userId: context.actor.userId,
            name: input.name,
          });
        } catch (error) {
          if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        return {
          id: space.id,
          name: space.name,
          isDefault: false,
          hasContent: false,
          canDelete: true,
          bots: [],
          groups: [],
          externalConversations: [],
          botSections: [],
        };
      }),
      remove: authed.spaces.remove.handler(async ({ context, input }) => {
        let claimId: string | null = null;
        let claimActive = false;
        let claimHealthy = true;
        let claimReleasable = false;
        let claimRenewal: ReturnType<typeof setInterval> | null = null;
        const deleteInput = {
          currentSpaceId: context.actor.spaceId,
          userId: context.actor.userId,
          spaceId: input.spaceId,
        };
        try {
          // Claim emptiness before external teardown. Bot and group creation
          // take the same lifecycle lock and reject the Space until deletion
          // finishes or this claim is released.
          const claim = await claimEmptySpaceDeletionForMember(deps.prisma, deleteInput);
          claimId = claim.claimId;
          claimActive = true;
          // A recovered worker can safely finish deletion, but cannot know
          // whether the previous worker still has provider teardown in flight.
          // Keep the Space claimed on failure so content cannot reuse it.
          claimReleasable = !claim.recovered;
          const claimedInput = { ...deleteInput, claimId };
          const assertClaim = async () => {
            if (!claimHealthy) throw new SpaceDeletionInProgressError();
            try {
              const renewed = await renewSpaceDeletionClaim(deps.prisma, claimedInput);
              if (!renewed) {
                claimHealthy = false;
                claimReleasable = false;
                throw new SpaceDeletionInProgressError();
              }
            } catch (error) {
              claimHealthy = false;
              claimReleasable = false;
              throw error;
            }
          };
          claimRenewal = setInterval(() => {
            void assertClaim().catch((renewalError) => {
              if (claimActive) {
                getLogger().error("space deletion claim renewal failed", renewalError);
              }
            });
          }, SPACE_DELETION_CLAIM_TIMEOUT_MS / 5);
          const adapterContext = connectionContext(context.actor, "spaces.remove", context.signal);
          for (const computer of claim.computers) {
            await assertClaim();
            // Provider errors are ambiguous: teardown may have reached the
            // remote service. From this point, only successful deletion may
            // unblock content creation; a stale recovery must finish it.
            claimReleasable = false;
            let teardownTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                deps.sandbox.destroy(toComputerRef(computer), {
                  ...adapterContext,
                  botId: computer.homeKey,
                }),
                new Promise<never>((_, reject) => {
                  teardownTimer = setTimeout(() => {
                    // Stop renewal so the claim goes stale and a later
                    // worker can recover; never release after teardown
                    // started, since the hung destroy may still complete.
                    claimHealthy = false;
                    claimReleasable = false;
                    reject(new Error("Space sandbox teardown timed out"));
                  }, spaceTeardownTimeoutMs());
                }),
              ]);
            } finally {
              if (teardownTimer !== undefined) clearTimeout(teardownTimer);
            }
            // Never clear a provider handle after this worker loses its claim.
            await assertClaim();
            await deps.prisma.computer.updateMany({
              where: {
                spaceId: input.spaceId,
                homeKey: computer.homeKey,
                providerRef: computer.providerRef,
                space: { deletionClaimId: claimId },
              },
              data: { state: "stopped", providerRef: null },
            });
          }
          await assertClaim();
          claimActive = false;
          if (claimRenewal) {
            clearInterval(claimRenewal);
            claimRenewal = null;
          }
          const fallback = await deleteEmptySpaceForMember(deps.prisma, claimedInput);
          return { ok: true as const, activeSpaceId: fallback.id };
        } catch (error) {
          if (context.signal?.aborted) claimReleasable = false;
          if (claimId && claimReleasable) {
            await releaseSpaceDeletionClaim(deps.prisma, { ...deleteInput, claimId }).catch(
              (releaseError) => {
                getLogger().error("space deletion claim release failed", releaseError);
              },
            );
          }
          if (error instanceof SpaceNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: error.message });
          }
          if (error instanceof CannotDeleteSpaceAsNonOwnerError) {
            throw new ORPCError("FORBIDDEN", { message: error.message });
          }
          if (error instanceof SpaceDeletionInProgressError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          if (
            error instanceof CannotDeleteDefaultSpaceError ||
            error instanceof CannotDeleteLastSpaceError ||
            error instanceof SpaceNotEmptyError
          ) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        } finally {
          claimActive = false;
          if (claimRenewal) clearInterval(claimRenewal);
        }
      }),
    },
    bootstrap: authed.bootstrap.handler(async ({ context, input }) => {
      const actor = context.actor;
      const [me, navigation, archivedBots, archivedGroups] = await Promise.all([
        meDto(deps, actor),
        spaceNavigationDto(deps, actor, repos, groupRepos),
        repos.listBots(actor, { archived: true }),
        groupRepos.listGroups(actor, { archived: true }),
      ]);
      const { bots, groups, botSections } = navigation.current;
      const active = bots.find((bot) => bot.id === input.botId) ?? bots[0];
      const [thread, routines] = active
        ? await Promise.all([
            resolveThreadTarget(deps.prisma, actor, { botId: active.id }).then((target) =>
              threadSnapshot(deps, target),
            ),
            listRoutinesDto(deps, actor, active.id),
          ])
        : [null, []];
      return {
        me,
        bots,
        groups,
        botSections,
        archivedBots,
        archivedGroups,
        thread,
        routines,
        spaces: navigation.spaces,
      };
    }),
    deployment: {
      get: authed.deployment.get.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
      update: authed.deployment.update.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        if (input.computerHost === "this-mac" && deps.env.sandboxProvider !== "docker") {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "This Mac mode is only available when SANDBOX_PROVIDER=docker on a personal local app.",
          });
        }
        await deps.prisma.deploymentSettings.upsert({
          where: { id: "default" },
          create: {
            id: "default",
            ownerUserId: context.actor.userId,
            signupsEnabled: input.signupsEnabled ?? true,
            signupAllowlist: (input.signupAllowlist ?? []).join(","),
            signupPolicyInitialized: true,
            computerHost: input.computerHost ?? undefined,
          },
          update: {
            ...(input.signupsEnabled === undefined ? {} : { signupsEnabled: input.signupsEnabled }),
            ...(input.signupAllowlist ? { signupAllowlist: input.signupAllowlist.join(",") } : {}),
            ...(input.signupsEnabled === undefined && input.signupAllowlist === undefined
              ? {}
              : { signupPolicyInitialized: true }),
            ...(input.computerHost === undefined ? {} : { computerHost: input.computerHost }),
          },
        });
        return deploymentDto(deps.prisma, deps.env.sandboxProvider);
      }),
    },
    updater: {
      status: authed.updater.status.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return readServerUpdateStatus(updaterConfig(deps));
      }),
      check: authed.updater.check.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        try {
          return await checkServerUpdate(updaterConfig(deps), input);
        } catch (error) {
          mapUpdaterError(error);
        }
      }),
      apply: authed.updater.apply.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        try {
          return await applyServerUpdate(updaterConfig(deps), input);
        } catch (error) {
          mapUpdaterError(error);
        }
      }),
    },
    host: {
      status: authed.host.status.handler(
        async ({ context }) =>
          (await sourceHostStatus(deps.prisma, context.actor.userId, deps.env.sandboxProvider)) ??
          deps.hostBridge?.status(context.actor.userId) ?? {
            configured: false,
            connected: false,
            health: null,
          },
      ),
      disconnect: authed.host.disconnect.handler(async ({ context }) => {
        if (!context.actor.isDeploymentOwner || !deps.hostBridge) throw new ORPCError("FORBIDDEN");
        return deps.hostBridge.disconnect(context.actor.userId);
      }),
    },
    runtimes: {
      availability: authed.runtimes.availability.handler(async ({ context, input }) =>
        process.env.ARDURBOT_HOST_BRIDGE === "api" && input.runtimeKind !== "pi"
          ? ((await deps.hostBridge?.status(context.actor.userId))?.health?.[
              input.runtimeKind === "claude-code" ? "claude" : "codex"
            ] ?? {
              runtimeKind: input.runtimeKind,
              available: false,
              models: [],
              reason: "Host service is not running — open the desktop app.",
            })
          : input.runtimeKind !== "pi" &&
              !(await nativeHostOwner(deps.prisma, context.actor.userId))
            ? {
                runtimeKind: input.runtimeKind,
                available: false,
                models: [],
                reason: NATIVE_HOST_OWNER_MESSAGE,
              }
            : nativeRuntimeAvailability(input.runtimeKind),
      ),
      connectCodex: authed.runtimes.connectCodex.handler(async ({ context }) => {
        if (!(await nativeHostOwner(deps.prisma, context.actor.userId)))
          throw new ORPCError("FORBIDDEN", { message: NATIVE_HOST_OWNER_MESSAGE });
        return nativeConnections.begin(context.actor.userId);
      }),
      connectStatus: authed.runtimes.connectStatus.handler(({ context, input }) =>
        nativeConnections.status(context.actor.userId, input.loginId),
      ),
      cancelConnect: authed.runtimes.cancelConnect.handler(async ({ context, input }) => {
        await nativeConnections.cancel(context.actor.userId, input.loginId);
        return { ok: true as const };
      }),
    },
    models: {
      list: authed.models.list.handler(async ({ context }) => {
        const state = await ollamaStatus(deps, context.actor, context.signal);
        return [
          ...listPiCatalog(),
          scriptedCatalogEntry,
          ollamaCatalogPlaceholder,
          ...ollamaCatalog(state.models, state.credentialId ?? ""),
        ];
      }),
      ollama: authed.models.ollama.handler(({ context }) =>
        ollamaStatus(deps, context.actor, context.signal),
      ),
      testOllama: authed.models.testOllama.handler(({ context, input }) =>
        ollamaStatus(deps, context.actor, context.signal, input.baseUrl),
      ),
      pullOllama: authed.models.pullOllama.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        const connection = await ollamaConnection(deps, context.actor);
        if (!connection) throw new ORPCError("BAD_REQUEST", { message: "Connect Ollama first." });
        return (async function* () {
          try {
            yield* pullOllamaModel(connection.baseUrl, input.model, context.signal);
          } catch (error) {
            if (context.signal?.aborted) return;
            throw new ORPCError("BAD_REQUEST", { message: ollamaErrorMessage(error) });
          }
        })();
      }),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userModelCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestModelCredentialOrder,
        });
        const compatibleRows = rows.filter(
          (row) =>
            row.provider === OPENAI_COMPATIBLE_PROVIDER_ID ||
            row.provider === "anthropic" ||
            row.provider === "ollama",
        );
        const secrets = compatibleRows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: compatibleRows.map((row) => row.secretId) },
                userId: context.actor.userId,
                spaceId: null,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        return rows.map((row) => {
          const preference = row.preferences[0];
          const selected = {
            ...row,
            isDefault: preference?.isDefault ?? false,
            defaultModel: preference?.modelId ?? null,
          };
          const ciphertext = ciphertextById.get(row.secretId);
          if (!ciphertext) return modelCredentialDto(selected);
          try {
            return modelCredentialDto(selected, deps.secrets.load(ciphertext, row.secretId));
          } catch {
            return modelCredentialDto(selected);
          }
        });
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        let plaintext: string;
        try {
          let previousPlaintext: string | undefined;
          let omitVisionModelIds = false;
          if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
            const credential = await findModelCredential(
              deps.prisma,
              context.actor,
              input.provider,
            );
            if (credential) {
              const secret = await deps.prisma.secret.findFirst({
                where: { id: credential.secretId, userId: context.actor.userId, spaceId: null },
                select: { ciphertext: true },
              });
              if (secret) {
                try {
                  previousPlaintext = deps.secrets.load(secret.ciphertext, credential.secretId);
                } catch (error) {
                  // Explicit key replacement must still succeed when the prior
                  // ciphertext is unreadable. Omit visionModelIds so a partial
                  // one-model list does not wipe other enabled models; DB
                  // supportsImages + defaultModel remain the legacy fallback.
                  if (input.apiKey === undefined) throw error;
                  omitVisionModelIds = true;
                }
              }
            }
          }
          plaintext = buildModelConnectPlaintext(input, previousPlaintext, {
            omitVisionModelIds,
          });
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid model connection",
          });
        }
        if (input.provider === "ollama") {
          const result = await ollamaStatus(deps, context.actor, context.signal, input.baseUrl);
          if (result.issue) throw new ORPCError("BAD_REQUEST", { message: result.issue });
          if (input.modelId && !result.models.some((model) => model.id === input.modelId))
            throw new ORPCError("BAD_REQUEST", {
              message: "This Ollama model is not installed. Change pin.",
            });
          input.modelId = input.modelId ?? result.models[0]?.id;
        }
        return persistModelCredential(deps, context.actor, {
          provider: input.provider,
          plaintext,
          label: input.label,
          modelId: input.modelId,
          supportsImages: input.supportsImages,
          signal: context.signal,
        });
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          try {
            const models = await probeOpenAiCompatibleModels(input, undefined, context.signal);
            return { models };
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not list models",
            });
          }
        },
      ),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        if (input.provider === "anthropic") {
          throw new ORPCError("BAD_REQUEST", {
            message: new AnthropicOAuthUnavailableError().message,
          });
        }
        return deps.oauthLogins.begin({
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          provider: input.provider,
          modelId: input.modelId,
          label: input.label,
          signal: context.signal,
        });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        return deps.oauthLogins.submit(input.loginId, context.actor, input.code);
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        const result = await deps.oauthLogins.complete(input.loginId, {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
        });
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        throwIfAborted(context.signal);
        const result = await deps.oauthLogins.finish(
          input.loginId,
          context.actor,
          async (login) => {
            if (login.provider === "anthropic") {
              throw new ORPCError("BAD_REQUEST", {
                message: new AnthropicOAuthUnavailableError().message,
              });
            }
            return persistModelCredential(deps, context.actor, {
              provider: login.provider,
              plaintext: serializeModelSecret({ kind: "oauth", credential: login.credential }),
              label: login.label ?? "ChatGPT Plus/Pro",
              modelId:
                usableModelId(login.modelId) ?? defaultCatalogModelId(login.provider) ?? undefined,
              signal: login.signal,
            });
          },
        );
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") {
          throw new ORPCError("NOT_FOUND", { message: result.error });
        }
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        if (input.provider === "ollama") {
          const state = await ollamaStatus(deps, context.actor, context.signal);
          if (state.issue || !state.models.some((model) => model.id === input.modelId))
            throw new ORPCError("BAD_REQUEST", {
              message: state.issue ?? "This Ollama model is not installed. Change pin.",
            });
        }
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const credential = await tx.userModelCredential.findFirst({
                where: { userId: context.actor.userId, provider: input.provider },
                orderBy: newestModelCredentialOrder,
              });
              if (!credential) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              await selectSpaceModelPreference(
                tx,
                context.actor,
                credential.id,
                usableModelId(input.modelId) ?? defaultCatalogModelId(input.provider),
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return { ok: true as const };
      }),
    },
    metrics: {
      context: authed.metrics.context.handler(({ context, input }) =>
        createContextService(deps.prisma, deps.memoryDocuments).metrics(context.actor, input),
      ),
    },
    context: {
      settings: authed.context.settings.handler(({ context, input }) =>
        createContextService(deps.prisma, deps.memoryDocuments).settings(
          context.actor,
          input.botId,
        ),
      ),
      configure: authed.context.configure.handler(({ context, input }) =>
        createContextService(deps.prisma, deps.memoryDocuments).configure(context.actor, input),
      ),
    },
    briefs: {
      list: authed.briefs.list.handler(({ context, input }) =>
        memoryRpc(() =>
          createContextService(deps.prisma, deps.memoryDocuments).briefs(context.actor, input),
        ),
      ),
      update: authed.briefs.update.handler(({ context, input }) =>
        memoryRpc(() =>
          createContextService(deps.prisma, deps.memoryDocuments).saveBrief(context.actor, input),
        ),
      ),
    },
    bots: {
      list: authed.bots.list.handler(async ({ context }) => repos.listBots(context.actor)),
      listArchived: authed.bots.listArchived.handler(async ({ context }) =>
        repos.listBots(context.actor, { archived: true }),
      ),
      get: authed.bots.get.handler(async ({ context, input }) => {
        const found = (await repos.listBots(context.actor)).find((bot) => bot.id === input.botId);
        if (!found) throw new IsolationError();
        return found;
      }),
      create: authed.bots.create.handler(async ({ context, input }) => {
        try {
          return await repos.createBot(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      duplicate: authed.bots.duplicate.handler(async ({ context, input }) => {
        const source = await repos.getBot(context.actor, input.botId);
        const duplicate = await repos
          .createBot(context.actor, {
            name: duplicateBotName(source.name),
            title: source.title,
            description: source.description,
            instructions: source.instructions,
            notifyOnFinish: source.notifyOnFinish,
            color: source.color,
            computerMode: source.computer?.scope === "dedicated" ? "dedicated" : "team",
            modelProvider: source.modelProvider,
            modelId: source.modelId,
            thinkingLevel: source.thinkingLevel,
            modelCredentialId: source.modelCredentialId,
            modelPinRevision: source.modelPinRevision,
            runtimeKind: source.runtimeKind,
            runtimeExperimental: source.runtimeExperimental,
          })
          .catch((error: unknown) => {
            throw mapSpaceLifecycleError(error);
          });
        const assignments = await deps.prisma.botMcpServer.findMany({
          where: {
            botId: source.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (assignments.length) {
          await deps.prisma.botMcpServer.createMany({
            data: assignments.map((assignment) => ({
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: duplicate.id,
              serverId: assignment.serverId,
              allowAllTools: false,
              needsReview: assignment.needsReview || assignment.allowAllTools,
              allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
            })),
          });
        }
        return duplicate;
      }),
      reorder: authed.bots.reorder.handler(async ({ context, input }) => {
        await repos.reorderBots(context.actor, input.botIds);
        return { ok: true as const };
      }),
      update: authed.bots.update.handler(async ({ context, input }) => {
        const existing = await repos.getBot(context.actor, input.botId);
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        const modelPinUpdate = await botModelPinUpdate(deps, context.actor, existing, input);
        if (!existing.thread) throw new IsolationError();
        await commitBotUpdate({
          prisma: deps.prisma,
          notify: (threadId, seq) => deps.events.notify(threadId, seq),
          spaceId: context.actor.spaceId,
          threadId: existing.thread.id,
          botId: input.botId,
          emitBotUpdated: botProfileLabelsChanged(input),
          data: {
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            concurrentRuns: input.concurrentRuns,
            notifyOnFinish: input.notifyOnFinish,
            color: input.color,
            pinned: input.pinned,
            memoryScope: input.memoryScope,
            sectionId: input.sectionId,
            voiceId: input.voiceId,
            autoSpeak: input.autoSpeak,
            ...modelPinUpdate,
            runtimeExperimental: input.runtimeExperimental,
            ...(input.teamChatAmbientEnabled !== undefined
              ? { teamChatAmbientEnabled: input.teamChatAmbientEnabled }
              : {}),
            ...(input.teamChatRules !== undefined ? { teamChatRules: input.teamChatRules } : {}),
          },
        });
        const bots = await repos.listBots(context.actor);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) throw new IsolationError();
        return bot;
      }),
      setComputer: authed.bots.setComputer.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const currentMode = bot.computer.scope === "dedicated" ? "dedicated" : "team";
        if (currentMode === input.mode) {
          return repos.setBotComputer(context.actor, bot.id, input.mode);
        }
        const claimed = await deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computerId} FOR UPDATE`;
          return tx.bot.updateMany({
            where: { id: bot.id, computerSwitching: false, computer: { maintenanceId: null } },
            data: { computerSwitching: true },
          });
        });
        if (claimed.count !== 1) throw new ORPCError("CONFLICT");
        try {
          const active = await deps.prisma.run.findFirst({
            where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            select: { id: true },
          });
          if (active) {
            throw new ORPCError("BAD_REQUEST", { message: "Stop the bot first" });
          }
          if (bot.computer.controlBotId === bot.id && hasActiveComputerControl(bot.computer)) {
            throw new ORPCError("BAD_REQUEST", { message: "Release the computer first" });
          }
          if (bot.computer.scope === "dedicated" && bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "computer.switch");
            const ref = toComputerRef(bot.computer);
            if (bot.computer.state === "running") {
              await checkpointAndRecordComputerWorkspace(deps, bot.computer, ref, ctx);
              await deps.sandbox.stop(ref, ctx);
            }
            await deps.prisma.computerExecutionLease.deleteMany({
              where: { computerId: bot.computer.id, botId: bot.id },
            });
            await deps.prisma.computer.update({
              where: { id: bot.computer.id },
              data: {
                state: "stopped",
                controlHolder: "none",
                controlLeaseId: null,
                controlLeaseExpiresAt: null,
                controlBotId: null,
                controlRunId: null,
                executionRunId: null,
                executionBotId: null,
                executionLeaseExpiresAt: null,
              },
            });
          }
          return await repos.setBotComputer(context.actor, bot.id, input.mode);
        } finally {
          await deps.prisma.bot.updateMany({
            where: { id: bot.id },
            data: { computerSwitching: false },
          });
        }
      }),
      archive: authed.bots.archive.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await archiveBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          computerContext(context.actor, bot.id, "archive"),
        );
        return { ok: true as const };
      }),
      restore: authed.bots.restore.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        if (!bot.archivedAt) return { ok: true as const };
        await deps.prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });
        return { ok: true as const };
      }),
      remove: authed.bots.remove.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId, { includeArchived: true });
        await destroyBot(
          {
            prisma: deps.prisma,
            sandbox: deps.sandbox,
            home: deps.home,
            jobs: deps.jobs,
            artifacts: deps.artifacts,
            dataDir: deps.dataDir,
          },
          bot,
          {
            operationId: "destroy",
            traceId: "destroy",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
          { deleteMemories: input.deleteMemories },
        );
        return { ok: true as const };
      }),
      rotateWebhookSecret: authed.bots.rotateWebhookSecret.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const plaintext = randomBytes(32).toString("base64url");
        const stored = await deps.secrets.put(plaintext, {
          operationId: "bots.rotateWebhookSecret",
          traceId: "bots.rotateWebhookSecret",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        await deps.prisma.$transaction(async (tx) => {
          const previousSecretId = bot.webhookSecretId;
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
              kind: "webhook",
              ciphertext: stored.ciphertext,
            },
          });
          await tx.bot.update({
            where: { id: bot.id },
            data: { webhookSecretId: stored.id },
          });
          if (previousSecretId) {
            await tx.secret.deleteMany({
              where: {
                id: previousSecretId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "webhook",
              },
            });
          }
        });
        return {
          secret: plaintext,
          path: `/api/v1/bots/${bot.id}/webhook`,
          webhookConfigured: true as const,
        };
      }),
    },
    groups: {
      create: authed.groups.create.handler(async ({ context, input }) => {
        try {
          return await groupRepos.createGroup(context.actor, input);
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      list: authed.groups.list.handler(async ({ context }) => groupRepos.listGroups(context.actor)),
      listArchived: authed.groups.listArchived.handler(async ({ context }) =>
        groupRepos.listGroups(context.actor, { archived: true }),
      ),
      get: authed.groups.get.handler(async ({ context, input }) => {
        const group = await groupRepos.getGroup(context.actor, input.groupId);
        return {
          ...groupRepos.mapGroup(group),
          messages: (
            await loadMessagePage(
              deps.prisma,
              group.thread!.id,
              undefined,
              THREAD_MESSAGE_PAGE_SIZE,
            )
          ).messages,
        };
      }),
      duplicate: authed.groups.duplicate.handler(async ({ context, input }) => {
        const source = await groupRepos.getGroup(context.actor, input.groupId);
        try {
          return await groupRepos.createGroup(context.actor, {
            name: duplicateBotName(source.name),
            botIds: source.members.map((member) => member.bot.id),
          });
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
      update: authed.groups.update.handler(async ({ context, input }) => {
        if (input.sectionId) {
          const section = await deps.prisma.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!section) throw new IsolationError();
        }
        const updated = await groupRepos.updateGroup(context.actor, input);
        await Promise.all(
          updated.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        return updated.group;
      }),
      archive: authed.groups.archive.handler(async ({ context, input }) => {
        const archived = await groupRepos.archiveGroup(context.actor, input.groupId);
        await Promise.all(
          archived.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        await Promise.all(
          archived.computers.map(async (computer) => {
            if (!computer.providerRef || !computer.executionBotId || !computer.executionRunId) {
              return;
            }
            const adapterContext = {
              operationId: "stop",
              traceId: "stop",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              botId: computer.executionBotId,
              runId: computer.executionRunId,
              screenLeaseId: screenLeaseIdForRun(
                { runId: computer.executionRunId, fence: computer.executionFence },
                computer.executionRunId,
              ),
              cancelRunWork: true,
              signal: new AbortController().signal,
            };
            const ref = toComputerRef(computer);
            await cancelComputerRunWork(
              deps.sandbox,
              ref,
              computer.id,
              computer.executionRunId,
              adapterContext,
            );
            await deps.sandbox.releaseScreen?.(ref, adapterContext).catch(() => undefined);
          }),
        );
        return { ok: true as const };
      }),
      restore: authed.groups.restore.handler(async ({ context, input }) => {
        await groupRepos.restoreGroup(context.actor, input.groupId);
        return { ok: true as const };
      }),
      remove: authed.groups.remove.handler(async ({ context, input }) => {
        const removed = await groupRepos.removeGroup(context.actor, input.groupId);
        const cleanup = await Promise.allSettled(
          removed.artifactStorageKeys.map((storageKey) =>
            deps.artifacts.remove(
              storageKey,
              computerContext(context.actor, removed.contextBotId, `group-remove:${input.groupId}`),
            ),
          ),
        );
        for (const result of cleanup) {
          if (result.status === "rejected")
            getLogger().error("group artifact cleanup", result.reason);
        }
        return { ok: true as const };
      }),
    },
    botSections: {
      list: authed.botSections.list.handler(async ({ context }) =>
        repos.listBotSections(context.actor),
      ),
      create: authed.botSections.create.handler(async ({ context, input }) =>
        repos.createBotSection(context.actor, input),
      ),
      update: authed.botSections.update.handler(async ({ context, input }) => {
        try {
          return await repos.updateBotSection(context.actor, input);
        } catch (error) {
          if (error instanceof BotSectionNameConflictError) {
            throw new ORPCError("CONFLICT", { message: error.message });
          }
          throw error;
        }
      }),
    },
    threads: {
      head: authed.threads.head.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadHead(deps.prisma, target);
      }),
      get: authed.threads.get.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadSnapshot(deps, target);
      }),
      messages: authed.threads.messages.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return loadMessagePage(
          deps.prisma,
          target.threadId,
          input.before,
          THREAD_MESSAGE_PAGE_SIZE,
          input.around,
          input.includePeerRuns,
          input.includePeerReceipts,
        );
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const peerRunCache = new Map<string, Promise<boolean>>();
        for await (const event of deps.events.follow(
          target.threadId,
          input.cursor,
          context.signal,
        )) {
          if (await isPeerRun(deps.prisma, event.runId, peerRunCache)) {
            if (!shouldForwardPeerThreadEvent(event)) continue;
          }
          yield event;
        }
      }),
      send: authed.threads.send.handler(async ({ context, input }) => {
        if ((await modelSetup(deps, context.actor)).needsModel) {
          throw new ORPCError("BAD_REQUEST", { message: "Connect a model to start a run." });
        }
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
        }
        return sendThreadMessage(deps, context.actor, target, input);
      }),
      react: authed.threads.react.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const result = await reactToThreadMessage(deps, context.actor, target, input);
        if (result.eventSeq != null) {
          await deps.events.notify(target.threadId, result.eventSeq).catch((error) => {
            getLogger().error("thread reaction realtime notification", error);
          });
        }
        if ("feedbackRunId" in result && result.feedbackRunId)
          await enqueueLearningReview(deps, result.feedbackRunId);
        return { ok: true as const };
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const runIds = await stopThreadRuns(deps, context.actor, target);
        for (const runId of runIds) await enqueueLearningReview(deps, runId);
        return { ok: true as const };
      }),
      restart: authed.threads.restart.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        const result = await deps.events.clearThread({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          botId: target.botId,
          preserveHistory: true,
        });
        await Promise.all(
          result.cancelledRunIds.map((runId) =>
            deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
          ),
        );
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const contextBotId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
        if (!contextBotId) throw new IsolationError();
        const { cancelledRunIds, historyCompactionGeneration } = await deps.events.clearThread({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          botId: contextBotId,
          ...(target.kind === "group" ? { groupId: target.groupId } : {}),
        });
        const [configuredMemory] = await Promise.all([
          target.kind === "bot"
            ? deps.memoryProviders.resolve(context.actor.spaceId).catch((error) => {
                getLogger().error("semantic memory resolution after thread clear failed", error);
                return null;
              })
            : Promise.resolve(null),
          Promise.all(
            cancelledRunIds.map((runId) =>
              deps.jobs.cancel(runJobKey(runId)).catch(() => undefined),
            ),
          ),
        ]);
        // Durable memories remain in their Space-private containers. Clear only removes
        // conversation-derived summaries from the previous generation; including the new
        // generation also covers a compaction job that began just after the clear committed.
        if (configuredMemory && target.kind === "bot") {
          // Best effort: the conversation rows are already deleted, so failing the clear here
          // would help nothing — a failed purge only leaves stale summaries recallable.
          try {
            const purged = await configuredMemory.provider.purgeHistory(
              {
                botId: target.botId,
                generations: [
                  Math.max(0, historyCompactionGeneration - 1),
                  historyCompactionGeneration,
                ],
              },
              computerContext(context.actor, target.botId, `thread-clear:${target.threadId}`),
            );
            if (!purged.ok) {
              getLogger().error("semantic memory purge after thread clear failed", purged.error);
            }
          } catch (error) {
            getLogger().error("semantic memory purge after thread clear failed", error);
          }
        }
        return { ok: true as const };
      }),
      followUp: authed.threads.followUp.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
          const sent = await deps.events.sendUserMessage({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            userId: context.actor.userId,
            blocks: [{ kind: "text", text: input.text }],
            prompt: input.text,
            trigger: "follow_up",
          });
          if (sent.taskId && sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("follow-up enqueue", error);
            });
          }
          return { ok: true as const };
        }
        const committed = await deps.prisma.$transaction(async (tx) => {
          await lockOwnedGroup(tx, context.actor, target.groupId);
          const group = await tx.chatGroup.findFirst({
            where: {
              id: target.groupId,
              archivedAt: null,
              thread: { id: target.threadId },
            },
            include: { members: { orderBy: { createdAt: "asc" } } },
          });
          const botId = group?.members[0]?.botId;
          if (!botId) throw new IsolationError();
          const blocks = [{ kind: "text" as const, text: input.text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            role: "user",
            blocks,
          });
          const active = await tx.run.findFirst({
            where: {
              threadId: target.threadId,
              botId,
              status: { in: [...ACTIVE_RUN_STATUSES] },
            },
            select: { id: true },
          });
          let run: { id: string } | null = null;
          if (!active) {
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                userId: context.actor.userId,
                prompt: input.text,
                status: "queued",
              },
            });
            run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "follow_up",
                sourceMessageId: message.id,
              },
              select: { id: true },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
          } else {
            await tx.steeringMessage.create({
              data: {
                messageId: message.id,
                botId,
                userId: context.actor.userId,
                runId: active.id,
              },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            type: "thread.message.created",
            runId: run?.id ?? active?.id,
            payload: { messageId: message.id, role: "user", blocks },
          });
          await touchGroupUpdatedAt(tx, target.groupId);
          return { runId: run?.id, eventSeq: event.seq };
        });
        await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
          getLogger().error("group follow-up realtime notification", error);
        });
        if (committed.runId) {
          await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
            getLogger().error("group follow-up enqueue", error);
          });
        }
        return { ok: true as const };
      }),
      answer: authed.threads.answer.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const answered = await deps.events.answerRunInput({
          spaceId: context.actor.spaceId,
          threadId: target.threadId,
          runId: input.runId,
          messageId: input.messageId,
          answeredByUserId: context.actor.userId,
          answer: input.answer,
        });
        if (!answered) {
          throw new ORPCError("CONFLICT", {
            message: "This prompt is no longer awaiting an answer",
          });
        }
        await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
          // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread answer enqueue", error);
        });
        return { ok: true as const };
      }),
      markRead: authed.threads.markRead.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await setThreadUnreadState(deps.prisma, context.actor, target, false);
        return { ok: true as const };
      }),
      markUnread: authed.threads.markUnread.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await setThreadUnreadState(deps.prisma, context.actor, target, true);
        return { ok: true as const };
      }),
    },
    fleet: {
      list: authed.fleet.list.handler(({ context }) =>
        fleetList(deps, computerContext(context.actor, "fleet", "fleet-list")),
      ),
      discover: authed.fleet.discover.handler(({ context }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return fleetDiscover(deps, computerContext(context.actor, "fleet", "fleet-discover"));
      }),
      test: authed.fleet.test.handler(({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return testFleetTarget(
          deps,
          computerContext(context.actor, "fleet", "fleet-test"),
          input.connectionId,
        );
      }),
      placement: authed.fleet.placement.handler(({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return savePlacement(
          deps,
          computerContext(context.actor, "fleet", "fleet-placement"),
          input,
        );
      }),
      bot: authed.fleet.bot.handler(({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return fleetBotPreference(
          deps,
          computerContext(context.actor, input.botId, "fleet-bot"),
          input,
        );
      }),
    },
    computer: {
      engine: authed.computer.engine.handler(({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return computerEngineInfo(
          deps,
          input.connectionId,
          computerContext(context.actor, "settings", "engine"),
        );
      }),
      list: authed.computer.list.handler(async ({ context }) => {
        const bots = await deps.prisma.bot.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId, archivedAt: null },
          include: { computer: true },
        });
        const hostLabel = await deploymentHostLabel(deps.prisma);
        const seen = new Set<string>();
        return bots.flatMap((bot) => {
          if (!bot.computer || seen.has(bot.computer.id)) return [];
          seen.add(bot.computer.id);
          const status = { ...toComputerStatus(bot.id, bot.computer), hostLabel };
          return [{ botId: bot.id, name: bot.name, status }];
        });
      }),
      connections: authed.computer.connections.handler(({ context }) =>
        listComputerConnections(deps.prisma, context.actor.spaceId),
      ),
      connect: authed.computer.connect.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return saveComputerConnection(
          deps,
          input,
          computerContext(context.actor, "settings", "connect"),
        );
      }),
      contexts: authed.computer.contexts.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        return kubernetesContexts({ inline: input.kubeconfig, path: input.kubeconfigPath });
      }),
      configure: authed.computer.configure.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const configuration = await validateComputerConfiguration(
          deps.prisma,
          context.actor.spaceId,
          input,
          deps.env.sandboxProvider,
        );
        try {
          await releaseMaintenanceControl(deps, context.actor, bot.computer.id);
          return await queueComputerUpdate(deps, bot.computer.id, bot.id, "update", configuration);
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      status: authed.computer.status.handler(async ({ context, input }) => ({
        ...(await computerStatus(deps, context.actor, input.botId)),
        hostLabel: await deploymentHostLabel(deps.prisma),
      })),
      boot: authed.computer.boot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          return computerStatus(deps, context.actor, input.botId);
        }
        const ctx = computerContext(context.actor, bot.id, "boot");
        const manualRunId = `boot:${randomUUID()}`;
        let lease: ComputerExecutionLease | null;
        try {
          lease = await acquireComputerExecutionLease(deps.prisma, {
            computerId: bot.computer.id,
            runId: manualRunId,
            botId: bot.id,
          });
        } catch (error) {
          if (error instanceof ComputerBusyError) {
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          }
          throw error;
        }
        try {
          await provisionComputer(deps, bot.computer.id, {
            ...ctx,
            screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
          });
          scheduleComputerSleep(deps.jobs, bot.computer.id);
        } catch (error) {
          if (error instanceof ComputerBusyError) {
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          }
          throw engineRefusal(error);
        } finally {
          await releaseComputerExecutionLease(deps.prisma, lease);
        }
        return computerStatus(deps, context.actor, input.botId);
      }),
      stop: authed.computer.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const controlLeaseId = bot.computer.controlLeaseId;
        const now = new Date();
        const claimed = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            state: { not: "suspending" },
            maintenanceId: null,
            executionLeases: {
              none: { botId: { not: bot.id }, expiresAt: { gt: now } },
            },
          },
          data: { state: "suspending" },
        });
        if (claimed.count !== 1) {
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        const otherRun = await deps.prisma.run.findFirst({
          where: {
            botId: { not: bot.id },
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId: bot.computer.id },
          },
          select: { id: true },
        });
        if (otherRun) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "suspending" },
            data: { state: bot.computer.state },
          });
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        await deps.prisma.computerExecutionLease.deleteMany({
          where: { computerId: bot.computer.id, botId: bot.id },
        });
        try {
          if (bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "stop");
            const ref = toComputerRef(bot.computer);
            await checkpointAndRecordComputerWorkspace(deps, bot.computer, ref, ctx);
            await deps.sandbox.stop(ref, ctx);
          }
          await deps.prisma.computer.update({
            where: { id: bot.computer.id },
            data: {
              state: "stopped",
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
        } catch (error) {
          await deps.prisma.computer
            .updateMany({
              where: { id: bot.computer.id, state: "suspending" },
              data: { state: "error" },
            })
            .catch(() => undefined);
          throw error;
        }
        await deps.jobs.cancel(
          computerControlExpireJobKey(bot.computer.id, controlLeaseId ?? undefined),
        );
        return computerStatus(deps, context.actor, input.botId);
      }),
      recover: authed.computer.recover.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        try {
          await releaseMaintenanceControl(deps, context.actor, bot.computer.id);
          return await queueComputerUpdate(deps, bot.computer.id, bot.id, "recover");
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      reset: authed.computer.reset.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "reset", "reset"),
      ),
      update: authed.computer.update.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (!computerSupportsUpdate(bot.computer.kind))
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer update is not available on this device",
          });
        try {
          await releaseMaintenanceControl(deps, context.actor, bot.computer.id);
          return await queueComputerUpdate(deps, bot.computer.id, bot.id);
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      updates: authed.computer.updates.handler(async ({ context }) => {
        const rows = await deps.prisma.computerUpdate.findMany({
          where: {
            status: { in: ["queued", "running", "interrupted", "failed"] },
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { userId: context.actor.userId, archivedAt: null } },
            },
          },
          include: {
            computer: {
              include: {
                bots: {
                  where: { userId: context.actor.userId, archivedAt: null },
                  select: { id: true, name: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        });
        return rows.map((row) => computerUpdateView(row, context.actor.isDeploymentOwner));
      }),
      releaseInterrupted: authed.computer.releaseInterrupted.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        // This is an attended lock release, never a heartbeat-based takeover.
        // The contract requires the operator's explicit workersStopped assertion.
        await deps.prisma.$transaction(async (tx) => {
          const update = await tx.computerUpdate.findFirst({
            where: {
              id: input.id,
              status: "interrupted",
              computer: {
                spaceId: context.actor.spaceId,
                bots: { some: { userId: context.actor.userId, archivedAt: null } },
              },
            },
          });
          if (!update) throw new ORPCError("CONFLICT");
          const failed = await tx.computerUpdate.updateMany({
            where: { id: update.id, status: "interrupted" },
            data: { status: "failed" },
          });
          if (failed.count !== 1) throw new ORPCError("CONFLICT");
          const released = await tx.computer.updateMany({
            where: { id: update.computerId, maintenanceId: update.id },
            data: { maintenanceId: null, state: "error" },
          });
          if (released.count !== 1) throw new ORPCError("CONFLICT");
        });
        return { ok: true as const };
      }),
      dismissUpdate: authed.computer.dismissUpdate.handler(async ({ context, input }) => {
        await deps.prisma.computerUpdate.updateMany({
          where: {
            id: input.id,
            status: "failed",
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { userId: context.actor.userId, archivedAt: null } },
            },
          },
          data: { status: "dismissed" },
        });
        return { ok: true as const };
      }),
      takeover: authed.computer.takeover.handler(
        guardComputerTakeover(deps.prisma, async ({ context, input }) => {
          let bot = await repos.getBot(context.actor, input.botId);
          if (!bot.computer?.providerRef || bot.computer.state !== "running") {
            throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
          }
          if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id) {
            await bindWaitingTakeoverToControl(deps, {
              spaceId: context.actor.spaceId,
              threadId: bot.thread?.id,
              botId: bot.id,
              computerId: bot.computer.id,
              controlLeaseId: bot.computer.controlLeaseId!,
              controlRunId: bot.computer.controlRunId,
            });
            await scheduleComputerControlExpiry(
              deps.jobs,
              bot.computer.id,
              bot.computer.controlLeaseId!,
              bot.computer.controlLeaseExpiresAt!,
            );
            return {
              leaseId: bot.computer.controlLeaseId!,
              expiresAt: bot.computer.controlLeaseExpiresAt!.toISOString(),
            };
          }
          if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId !== bot.id) {
            const previousBotId = bot.computer.controlBotId!;
            await deps.sandbox.setScreenControl?.(
              toComputerRef(bot.computer),
              false,
              computerContext(context.actor, previousBotId, "screen.release"),
              bot.computer.controlLeaseId ?? undefined,
            );
            await deps.prisma.computer.updateMany({
              where: { id: bot.computer.id, controlLeaseId: bot.computer.controlLeaseId },
              data: {
                controlHolder: "none",
                controlLeaseId: null,
                controlLeaseExpiresAt: null,
                controlBotId: null,
                controlRunId: null,
              },
            });
            bot = await repos.getBot(context.actor, input.botId);
            if (!bot.computer) throw new IsolationError();
          }
          if (bot.computer.controlLeaseId) {
            await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
            bot = await repos.getBot(context.actor, input.botId);
          }
          if (!bot.computer) throw new IsolationError();

          const executionLease = await deps.prisma.computerExecutionLease.findUnique({
            where: { computerId_botId: { computerId: bot.computer.id, botId: bot.id } },
          });
          const executionRun = executionLease
            ? await deps.prisma.run.findUnique({
                where: { id: executionLease.runId },
                select: { botId: true, status: true },
              })
            : null;
          const waitingForTakeover =
            executionRun?.botId === bot.id &&
            (executionRun.status === "waiting_takeover" ||
              bot.computer.controlRunId === executionLease?.runId);
          if (
            executionBlocksUserTakeover({
              hasLease: Boolean(executionLease),
              leaseExpiresAt: executionLease?.expiresAt,
              runStatus: executionRun?.status,
              takeoverRequested: waitingForTakeover,
            })
          ) {
            throw new ORPCError("CONFLICT", { message: "Stop the bot first" });
          }
          // Keep an inactive lease as a fencing tombstone. The next run reclaims it
          // with a higher fence, even if this user's screen remains connected.

          const leaseId = randomUUID();
          const expiresAt = new Date(Date.now() + takeoverLeaseMs());
          const granted = await deps.prisma.computer.updateMany({
            where: {
              id: bot.computer.id,
              state: "running",
              maintenanceId: null,
              controlHolder: { not: "user" },
              controlLeaseId: null,
            },
            data: {
              controlHolder: "user",
              controlLeaseId: leaseId,
              controlLeaseExpiresAt: expiresAt,
              controlBotId: bot.id,
              controlRunId: waitingForTakeover ? executionLease?.runId : null,
              state: "running",
            },
          });
          if (granted.count !== 1) {
            const current = await deps.prisma.computer.findUniqueOrThrow({
              where: { id: bot.computer.id },
            });
            if (!hasActiveComputerControl(current) || current.controlBotId !== bot.id) {
              throw new ORPCError("CONFLICT", { message: "Computer control changed; try again" });
            }
            await bindWaitingTakeoverToControl(deps, {
              spaceId: context.actor.spaceId,
              threadId: bot.thread?.id,
              botId: bot.id,
              computerId: current.id,
              controlLeaseId: current.controlLeaseId!,
              controlRunId: current.controlRunId,
            });
            await scheduleComputerControlExpiry(
              deps.jobs,
              current.id,
              current.controlLeaseId!,
              current.controlLeaseExpiresAt!,
            );
            return {
              leaseId: current.controlLeaseId!,
              expiresAt: current.controlLeaseExpiresAt!.toISOString(),
            };
          }
          try {
            await scheduleComputerControlExpiry(deps.jobs, bot.computer.id, leaseId, expiresAt);
          } catch (error) {
            await deps.prisma.computer.updateMany({
              where: { id: bot.computer.id, controlLeaseId: leaseId },
              data: {
                controlHolder: "none",
                controlLeaseId: null,
                controlLeaseExpiresAt: null,
                controlBotId: null,
                controlRunId: null,
              },
            });
            throw error;
          }
          if (bot.thread) {
            await deps.events.append({
              spaceId: context.actor.spaceId,
              threadId: bot.thread.id,
              botId: bot.id,
              type: "computer.takeover.granted",
              payload: { leaseId, takeoverRequested: waitingForTakeover },
            });
          }
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          return { leaseId, expiresAt: expiresAt.toISOString() };
        }),
      ),
      release: authed.computer.release.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const controlBotId = bot.computer.controlBotId;
        const controlLeaseId = bot.computer.controlLeaseId;
        if (bot.computer.controlHolder !== "user" || !controlBotId || controlBotId !== bot.id) {
          return { ok: true as const };
        }
        if (!hasActiveComputerControl(bot.computer) || !controlLeaseId) {
          // Stale controlHolder=user. Prefer expiry (revokes provider control). If a lease id
          // remains after a failed revoke, keep it so reconciliation can retry.
          if (controlLeaseId) {
            await expireComputerControl(deps, bot.computer.id, controlLeaseId).catch(
              () => undefined,
            );
          } else {
            await clearInactiveUserComputerControl(deps.prisma, bot.computer.id);
          }
          return { ok: true as const };
        }
        await deps.prisma.computer.updateMany({
          where: { id: bot.computer.id, controlLeaseId },
          data: { controlHolder: "none" },
        });
        if (bot.computer.providerRef) {
          await deps.sandbox.setScreenControl?.(
            toComputerRef(bot.computer),
            false,
            computerContext(context.actor, controlBotId, "screen.release"),
            controlLeaseId,
          );
        }

        const released = await deps.events.finalizeComputerControlRelease({
          spaceId: context.actor.spaceId,
          computerId: bot.computer.id,
          botId: controlBotId,
          runId: bot.computer.controlRunId,
          leaseId: controlLeaseId,
          holder: "bot",
          reason: input.reason ?? "released",
        });
        if (!released) return { ok: true as const };
        // The lease-specific key makes this cancellation safe after a replacement takeover.
        await deps.jobs
          .cancel(computerControlExpireJobKey(bot.computer.id, controlLeaseId))
          .catch((error) => {
            // The expired job is harmless after the lease is cleared, so do not report a
            // failed release after the transaction has committed.
            getLogger().error("computer control expiry cancellation", error);
          });

        await enqueueTakeoverContinuation(deps.jobs, released.runId);
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        return { ok: true as const };
      }),
      input: authed.computer.input.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer || !hasActiveComputerControl(computer) || computer.controlBotId !== bot.id) {
          await expireStaleComputerControl(deps, computer);
          throw new ORPCError("FORBIDDEN");
        }
        if (!computer.providerRef) return { ok: true as const };
        const mapped =
          input.kind === "key"
            ? { kind: "key" as const, key: String(input.payload.key ?? "") }
            : input.kind === "clipboard"
              ? { kind: "clipboard" as const, text: String(input.payload.text ?? "") }
              : input.kind === "scroll"
                ? {
                    kind: "scroll" as const,
                    direction:
                      input.payload.direction === "up" ? ("up" as const) : ("down" as const),
                    amount: Number(input.payload.amount ?? 3),
                  }
                : {
                    kind: "pointer" as const,
                    x: Number(input.payload.x ?? 0),
                    y: Number(input.payload.y ?? 0),
                    button: (input.payload.button as "left" | "right" | undefined) ?? "left",
                    type:
                      (input.payload.type as "move" | "down" | "up" | "click" | undefined) ??
                      "click",
                  };
        const outcome = await taughtSkills.recordInput(context.actor, bot.id, mapped);
        if (outcome === "stale") return { ok: true as const };
        if (outcome !== "recorded") {
          await applyTeachingDesktopInput(
            deps.sandbox,
            computer,
            mapped,
            computerContext(context.actor, bot.id, "input"),
          );
        }
        await deps.prisma.computer.updateMany({
          where: { id: computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        return { ok: true as const };
      }),
      files: authed.computer.files.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computer = bot.computer;
        const computerMode = parseComputerMode(computer.scope);
        const ctx = computerContext(context.actor, bot.id, "files");
        const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
        let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
        if (computer.state === "running" && computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
          entries = await deps.sandbox.listFiles(toComputerRef(computer), storedPath, ctx);
        } else {
          entries = await deps.home.list(computer.homeKey, storedPath, ctx);
        }
        return entries.map((entry) => ({
          ...entry,
          path: displayBotWorkspacePath(computerMode, bot.id, input.path, entry.path),
        }));
      }),
      readFile: authed.computer.readFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computerMode = parseComputerMode(bot.computer.scope);
        const ctx = computerContext(context.actor, bot.id, "read");
        const storedPath = resolveBotWorkspacePath(computerMode, bot.id, input.path);
        let content: string;
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, bot.computer.id);
          const bytes = await deps.sandbox.readFile(toComputerRef(bot.computer), storedPath, ctx, {
            maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
          });
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } else {
          try {
            content = await deps.home.readFile(bot.computer.homeKey, storedPath, ctx, {
              maxBytes: MAX_COMPUTER_TEXT_FILE_BYTES,
            });
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("agent home file exceeds ")) {
              throw new ORPCError("BAD_REQUEST", { message: "file is too large to preview" });
            }
            throw error;
          }
        }
        return { path: input.path, content };
      }),
      screenUrl: authed.computer.screenUrl.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (
          bot.computer?.kind === "kubernetes" ||
          !bot.computer?.providerRef ||
          (bot.computer.state !== "running" && bot.computer.state !== "booting")
        ) {
          return { url: null };
        }
        const computer = bot.computer;
        const session = await deps.sandbox
          .connectScreen(
            toComputerRef(computer),
            {
              view: "stream",
              interactive: hasActiveComputerControl(computer) && computer.controlBotId === bot.id,
              controlToken:
                computer.controlBotId === bot.id
                  ? (computer.controlLeaseId ?? undefined)
                  : undefined,
            },
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (isComputerScreenUnavailable(error)) {
              throw new ORPCError("CONFLICT", { message: error.message });
            }
            if (!isSandboxGoneError(error)) throw error;
            // The provider killed this sandbox (idle timeout) while the row still says
            // running. Clear the dead ref so the UI offers a boot instead of 500ing.
            // Leave any active control lease alone — expireComputerControl owns that
            // release (provider screen-control, events, takeover continuation).
            getLogger().error(
              `computer ${computer.id} sandbox ${computer.providerRef} is gone`,
              error,
            );
            await deps.prisma.computer.updateMany({
              where: { id: computer.id, providerRef: computer.providerRef },
              data: { state: "stopped", providerRef: null },
            });
            return null;
          });
        if (!session?.url) return { url: null };
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        const viewUrl = withViewOnly(
          session.url,
          !(hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id),
        );
        return {
          url: addScreenProxyCapability(viewUrl, deps.env.screenProxySecret, deps.env.webOrigin, {
            botId: bot.id,
            computerId: computer.id,
            botGeneration: bot.screenGeneration,
            computerGeneration: computer.screenGeneration,
            controlLeaseId: computer.controlLeaseId,
          }),
        };
      }),
      heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer?.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          await touchRunningComputer(
            { sandbox: deps.sandbox, jobs: deps.jobs },
            {
              id: bot.computer.id,
              homeKey: bot.computer.homeKey,
              providerRef: bot.computer.providerRef,
              kind: bot.computer.kind,
            },
          ).catch(() => undefined);
        }
        return { ok: true as const };
      }),
    },
    localImport: {
      credentials: authed.localImport.credentials.handler(async ({ context, input }) => {
        const owner = importOwner(context.actor);
        await assertLocalImportOwner(deps.prisma, owner);
        return saveImportedServerCredentials(deps.prisma, deps.secrets, owner, input);
      }),
      status: authed.localImport.status.handler(({ context }) =>
        localImport.status(importOwner(context.actor)),
      ),
      configure: authed.localImport.configure.handler(async ({ context, input }) => {
        try {
          return await localImport.configure(importOwner(context.actor), input);
        } catch (error) {
          if (error instanceof LocalImportInvalidFolderError)
            throw new ORPCError(LOCAL_IMPORT_INVALID_FOLDER_CODE, { message: error.message });
          throw error;
        }
      }),
      run: authed.localImport.run.handler(async ({ context, input }) => {
        const owner = importOwner(context.actor);
        await assertLocalImportOwner(deps.prisma, owner);
        if (!deps.localImportRequests)
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            message: "The import worker is unavailable.",
          });
        return deps.localImportRequests.run(owner, input);
      }),
    },
    memory: {
      propose: authed.memory.propose.handler(({ context, input }) =>
        memoryRpc(() =>
          proposeMemoryIntent({ ...deps, secretStore: deps.secrets }, context.actor, input),
        ),
      ),
      remember: authed.memory.remember.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        await memoryRpc(() =>
          deps.memory.commit(
            {
              scope: "bot",
              botId: bot.id,
              path: `notes/${input.nonce}.md`,
              content: input.text,
              sourceThreadId: bot.thread?.id,
            },
            memoryContext(context.actor),
          ),
        );
        return { ok: true as const };
      }),
      list: authed.memory.list.handler(({ context, input }) =>
        memoryRpc(() => deps.memoryDocuments!.list(input, memoryContext(context.actor))),
      ),
      update: authed.memory.update.handler(({ context, input }) =>
        memoryRpc(() =>
          deps.memoryDocuments!.update(
            input.documentId,
            input.content,
            input.expectedRevision,
            memoryContext(context.actor),
          ),
        ),
      ),
      history: authed.memory.history.handler(({ context, input }) =>
        memoryRpc(() =>
          deps.memoryDocuments!.history(input.documentId, input, memoryContext(context.actor)),
        ),
      ),
      restore: authed.memory.restore.handler(({ context, input }) =>
        memoryRpc(() =>
          deps.memoryDocuments!.restore(
            input.documentId,
            input.revision,
            input.expectedRevision,
            memoryContext(context.actor),
          ),
        ),
      ),
      delete: authed.memory.delete.handler(({ context, input }) =>
        memoryRpc(() =>
          deps.memoryDocuments!.delete(
            input.documentId,
            input.expectedRevision,
            memoryContext(context.actor),
          ),
        ),
      ),
      retry: authed.memory.retry.handler(({ context, input }) =>
        memoryRpc(() =>
          deps.memoryDocuments!.retry(input.documentId, memoryContext(context.actor)),
        ),
      ),
      export: authed.memory.export.handler(({ context }) =>
        memoryRpc(() => deps.memoryDocuments!.exportBundle(memoryContext(context.actor))),
      ),
      import: authed.memory.import.handler(({ context, input }) =>
        memoryRpc(() => deps.memoryDocuments!.importBundle(input, memoryContext(context.actor))),
      ),
      retrySync: authed.memory.retrySync.handler(async ({ context }) => {
        const access = memoryContext(context.actor);
        await deps.memoryDocuments!.dependencies.enqueueGit?.({
          ...access,
          memoryGeneration: await deps.memoryDocuments!.generation(access),
        });
        return { ok: true as const };
      }),
      syncState: authed.memory.syncState.handler(({ context }) =>
        memoryRpc(() => deps.memoryDocuments!.syncState(memoryContext(context.actor))),
      ),
      gitLocation: authed.memory.gitLocation.handler(async ({ context, input }) => {
        const result = await memoryRpc(() => changeGitMemoryLocation(deps, context.actor, input));
        if (result.config)
          await deps.jobs
            .enqueue({
              name: "memory.git-push",
              payload: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                generation: result.generation,
              },
              replaceKey: `memory.git-push:${context.actor.spaceId}`,
            })
            .catch(() => undefined);
        return result;
      }),
      location: authed.memory.location.handler(({ context, input }) =>
        memoryRpc(() => changeMemoryLocation(deps, context.actor, input)),
      ),
      exportMarkdown: authed.memory.exportMarkdown.handler(({ context, input }) =>
        memoryRpc(async () => {
          const bundle = await deps.memoryDocuments!.exportBundle(memoryContext(context.actor));
          return bundle.documents
            .map((doc) => doc.revisions.at(-1)!)
            .filter(
              (doc) =>
                !doc.deletedAt &&
                (!input.botId ||
                  (doc.scopeKey.kind === "bot" && doc.scopeKey.botId === input.botId)),
            )
            .map((doc) => `# ${doc.path}\n\n${doc.content}`)
            .join("\n\n");
        }),
      ),
      providerConfig: authed.memory.providerConfig.handler(async ({ context }) => {
        const config = await findSpaceMemoryConfig(deps.prisma, context.actor.spaceId);
        return config ? serializeSpaceMemoryConfig(config) : null;
      }),
      testProvider: authed.memory.testProvider.handler(({ context, input }) =>
        testMemoryProviderConnection(deps, context.actor, input),
      ),
      deliveryProgress: authed.memory.deliveryProgress.handler(({ context }) =>
        memoryRpc(() => deps.memoryDocuments!.deliveryProgress(memoryContext(context.actor))),
      ),
      connectProvider: authed.memory.connectProvider.handler(async ({ context, input }) =>
        persistMemoryProviderConfig(deps, context.actor, input),
      ),
      setDefaultScope: authed.memory.setDefaultScope.handler(async ({ context, input }) =>
        updateMemoryProviderDefaultScope(deps, context.actor, input.defaultMemoryScope),
      ),
      disconnectProvider: authed.memory.disconnectProvider.handler(async ({ context }) =>
        disconnectMemoryProvider(deps, context.actor),
      ),
    },
    routines: {
      overview: authed.routines.overview.handler(({ context }) =>
        routineOverview(deps.prisma, context.actor),
      ),
      history: authed.routines.history.handler(({ context, input }) =>
        routineHistory(deps.prisma, context.actor, input.routineId),
      ),
      list: authed.routines.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listRoutinesDto(deps, context.actor, input.botId);
      }),
      create: authed.routines.create.handler(async ({ context, input }) => {
        if (hasMixedOneShotSchedule(input.crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (input.active && isOneShotRoutineCrons(input.crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "One-shot schedules must be created from chat.",
          });
        }
        const bot = await repos.getBot(context.actor, input.botId);
        // Validate every recurring cron even when inactive; @once and webhook-only have no next date.
        let nextRunAt: Date | null = null;
        if (input.crons.length > 0 && !isOneShotRoutineCrons(input.crons)) {
          const computedNextRunAt = nextRoutineDate(input.crons, input.timezone);
          nextRunAt = input.active ? computedNextRunAt : null;
        }
        const row = await deps.prisma.routine.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            name: input.name,
            prompt: input.prompt,
            crons: input.crons,
            timezone: input.timezone,
            notify: input.notify,
            active: input.active,
            webhookEnabled: input.webhookEnabled,
            githubEnabled: input.githubEnabled,
            messageProvider: input.messageProvider,
            nextRunAt,
          },
        });
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.created",
            payload: { name: row.name },
          });
        }
        if (row.active && row.nextRunAt) {
          await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
        }
        return mapRoutine(row);
      }),
      update: authed.routines.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const active = input.active ?? existing.active;
        const crons = input.crons ?? existing.crons;
        const timezone = input.timezone ?? existing.timezone;
        const webhookEnabled = input.webhookEnabled ?? existing.webhookEnabled;
        const githubEnabled = input.githubEnabled ?? existing.githubEnabled;
        const messageProvider =
          input.messageProvider === undefined ? existing.messageProvider : input.messageProvider;
        if (crons.length === 0 && !webhookEnabled && !githubEnabled && !messageProvider) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Add a schedule, webhook, GitHub, or message trigger",
          });
        }
        if (hasMixedOneShotSchedule(crons)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A one-time schedule can't be combined with other schedules.",
          });
        }
        if (active && isOneShotRoutineCrons(crons)) {
          if (!isOneShotRoutineCrons(existing.crons)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "One-shot schedules must be created from chat.",
            });
          }
          if (!existing.nextRunAt && existing.lastRunAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "This one-shot already ran.",
            });
          }
        }
        const scheduleChanged =
          (!existing.active && active) ||
          (input.crons !== undefined &&
            JSON.stringify(input.crons) !== JSON.stringify(existing.crons)) ||
          (input.timezone !== undefined && input.timezone !== existing.timezone);
        const recalculatedNextRunAt =
          crons.length > 0 &&
          !isOneShotRoutineCrons(crons) &&
          (scheduleChanged || (active && !existing.nextRunAt))
            ? nextRoutineDate(crons, timezone)
            : null;
        let armedOneShotAt: Date | null = null;
        if (active && isOneShotRoutineCrons(crons) && !existing.nextRunAt && !existing.lastRunAt) {
          if (!input.runAt) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Add a run time for this one-shot.",
            });
          }
          const parsed = new Date(input.runAt);
          if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Run time must be in the future.",
            });
          }
          armedOneShotAt = parsed;
        } else if (input.runAt !== undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A run time is only for one-shots that have not run yet.",
          });
        }
        const nextRunAt = !active
          ? null
          : crons.length === 0
            ? null
            : isOneShotRoutineCrons(crons)
              ? (armedOneShotAt ?? existing.nextRunAt)
              : (recalculatedNextRunAt ?? existing.nextRunAt);
        const row = await deps.prisma.routine.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            prompt: input.prompt,
            crons: input.crons,
            timezone: input.timezone,
            active: input.active,
            notify: input.notify,
            webhookEnabled: input.webhookEnabled,
            githubEnabled: input.githubEnabled,
            messageProvider: input.messageProvider,
            nextRunAt,
          },
        });
        const bot = await repos.getBot(context.actor, row.botId);
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "routine.updated",
            payload: { routineId: row.id, active: row.active },
          });
        }
        const scheduleNeedsSync =
          existing.active !== row.active ||
          scheduleChanged ||
          (!existing.nextRunAt && !!row.nextRunAt);
        if (scheduleNeedsSync) {
          if (row.active && row.nextRunAt) {
            await deps.jobs.enqueue(routineWakeupJob(row.id, row.nextRunAt));
          } else {
            await deps.jobs.cancel(routineJobKey(row.id));
          }
        }
        return mapRoutine(row);
      }),
      remove: authed.routines.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.routine.findFirst({
          where: { id: input.routineId, spaceId: context.actor.spaceId },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.routine.delete({ where: { id: existing.id } });
        await deps.jobs.cancel(routineJobKey(existing.id));
        return { ok: true as const };
      }),
      testRun: authed.routines.testRun.handler(async ({ context, input }) => {
        const routine = await deps.prisma.routine.findFirst({
          where: {
            id: input.routineId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!routine) throw new IsolationError();
        const bot = await repos.getBot(context.actor, routine.botId);
        if (!bot.thread) throw new IsolationError();
        const threadId = bot.thread.id;
        const nonce = input.clientNonce ? `routine-test:${input.clientNonce}` : undefined;
        if (nonce) {
          const existing = await deps.prisma.run.findFirst({
            where: { threadId, clientNonce: nonce },
            select: { id: true },
          });
          if (existing) return { runId: existing.id };
        }
        const prompt = routine.prompt;
        let run: { id: string };
        try {
          // Task + run must commit together so a nonce collision cannot leave an orphan queued Task.
          run = await deps.prisma.$transaction(async (tx) => {
            if (nonce) {
              const existing = await tx.run.findFirst({
                where: { threadId, clientNonce: nonce },
                select: { id: true },
              });
              if (existing) return existing;
            }
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId: bot.id,
                threadId,
                userId: context.actor.userId,
                prompt,
                status: "queued",
              },
            });
            return tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId: bot.id,
                threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "routine",
                routineId: routine.id,
                clientNonce: nonce,
              },
              select: { id: true },
            });
          });
        } catch (error) {
          if (nonce) {
            const existing = await deps.prisma.run.findFirst({
              where: { threadId, clientNonce: nonce },
              select: { id: true },
            });
            if (existing) return { runId: existing.id };
          }
          throw error;
        }
        // Keep enqueue outside the nonce-collision catch. The queued run is durable;
        // log enqueue failures and still return success — the reconciler repairs a missed wake.
        await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          getLogger().error("routine testRun enqueue", error);
        });
        return { runId: run.id };
      }),
    },
    scratchpad: {
      list: authed.scratchpad.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listScratchpadItems(
          { prisma: deps.prisma },
          {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            status: input.status,
            includeDone: input.includeDone ?? false,
          },
        );
      }),
      create: authed.scratchpad.create.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const row = await deps.prisma.scratchpadItem.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            title: input.title.trim(),
            status: input.status,
            notes: input.notes.trim(),
          },
        });
        return mapScratchpadItem(row);
      }),
      update: authed.scratchpad.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        if (input.status !== undefined && !isScratchpadStatus(input.status)) {
          throw new ORPCError("BAD_REQUEST", { message: "Invalid scratchpad status." });
        }
        const row = await deps.prisma.scratchpadItem.update({
          where: { id: existing.id },
          data: {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
          },
        });
        return mapScratchpadItem(row);
      }),
      remove: authed.scratchpad.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.scratchpadItem.delete({ where: { id: existing.id } });
        return { ok: true as const };
      }),
    },
    skills: {
      list: authed.skills.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.list(context.actor, input.botId);
      }),
      get: authed.skills.get.handler(async ({ context, input }) =>
        taughtSkills.get(context.actor, input.skillId),
      ),
      start: authed.skills.start.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.start(context.actor, input.botId, input.goal);
      }),
      appendEvent: authed.skills.appendEvent.handler(async ({ context, input }) =>
        taughtSkills.appendEvent(context.actor, input.skillId, input.event),
      ),
      snapshot: authed.skills.snapshot.handler(async ({ context, input }) =>
        taughtSkills.snapshot(context.actor, input.skillId),
      ),
      stop: authed.skills.stop.handler(async ({ context, input }) =>
        taughtSkills.stop(context.actor, input.skillId),
      ),
      updateDraft: authed.skills.updateDraft.handler(async ({ context, input }) =>
        memoryRpc(() =>
          taughtSkills.updateDraft(context.actor, input.skillId, {
            name: input.name,
            playbook: input.playbook,
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
      save: authed.skills.save.handler(async ({ context, input }) =>
        taughtSkills.save(context.actor, input.skillId, input.name),
      ),
      testRun: authed.skills.testRun.handler(async ({ context, input }) =>
        taughtSkills.testRun(context.actor, input.skillId, input.prompt),
      ),
      remove: authed.skills.remove.handler(async ({ context, input }) =>
        taughtSkills.remove(context.actor, input.skillId),
      ),
    },
    learning: {
      proposal: authed.learning.proposal.handler(({ context, input }) =>
        learning.proposal(context.actor, input.proposalId),
      ),
      observation: authed.learning.observation.handler(({ context, input }) =>
        learning.observation(context.actor, input.documentId, input.revision),
      ),
      journey: authed.learning.journey.handler(({ context, input }) =>
        learning.journey(context.actor, input.botId),
      ),
      curator: authed.learning.curator.handler(({ context }) => learning.curator(context.actor)),
      curate: authed.learning.curate.handler(({ context }) => learning.curate(context.actor)),
      skillCare: authed.learning.skillCare.handler(({ context, input }) =>
        learning.skillCare(context.actor, input.skillId, input.lifecycleTag),
      ),
      summary: authed.learning.summary.handler(({ context, input }) =>
        learning.summary(context.actor, input.botId),
      ),
      approve: authed.learning.approve.handler(({ context, input }) =>
        learning.approve(input.proposalId, context.actor, input.edits),
      ),
      reject: authed.learning.reject.handler(({ context, input }) =>
        learning.reject(input.proposalId, context.actor, input.reason),
      ),
      edit: authed.learning.edit.handler(({ context, input }) =>
        learning.edit(input.proposalId, context.actor, input.edits),
      ),
      revert: authed.learning.revert.handler(({ context, input }) =>
        learning.revert(input.proposalId, context.actor),
      ),
      evidence: authed.learning.evidence.handler(({ context, input }) =>
        learning.evidence(context.actor, input.proposalId, input.evidenceId),
      ),
      grants: authed.learning.grants.handler(({ context }) => learning.grants(context.actor)),
      createGrant: authed.learning.createGrant.handler(({ context, input }) =>
        learning.createGrant(context.actor, input),
      ),
      revokeGrant: authed.learning.revokeGrant.handler(({ context, input }) =>
        learning.revokeGrant(context.actor, input.grantId),
      ),
      declineGrant: authed.learning.declineGrant.handler(({ context, input }) =>
        learning.declineGrant(context.actor, input),
      ),
      settings: authed.learning.settings.handler(({ context }) => learning.settings(context.actor)),
      configure: authed.learning.configure.handler(({ context, input }) =>
        learning.configure(context.actor, input),
      ),
      list: authed.learning.list.handler(({ context, input }) =>
        learning.list(context.actor, input.botId),
      ),
      review: authed.learning.review.handler(({ context, input }) =>
        learning.review(context.actor, input.runId),
      ),
    },
    agentSkills: {
      list: authed.agentSkills.list.handler(async ({ context }) => agentSkills.list(context.actor)),
      get: authed.agentSkills.get.handler(async ({ context, input }) =>
        agentSkills.get(context.actor, input),
      ),
      create: authed.agentSkills.create.handler(async ({ context, input }) =>
        agentSkills.create(context.actor, input),
      ),
      update: authed.agentSkills.update.handler(async ({ context, input }) =>
        memoryRpc(() => agentSkills.update(context.actor, input)),
      ),
      remove: authed.agentSkills.remove.handler(async ({ context, input }) =>
        agentSkills.remove(context.actor, input.skillId),
      ),
    },
    capabilities: {
      settings: authed.capabilities.settings.handler(({ context }) =>
        createCapabilitySettings(deps).settings(context.actor),
      ),
      configure: authed.capabilities.configure.handler(({ context, input }) =>
        createCapabilitySettings(deps).configure(context.actor, input),
      ),
      network: authed.capabilities.network.handler(({ context, input }) =>
        createCapabilitySettings(deps).network(context.actor, input),
      ),
      list: authed.capabilities.list.handler(async ({ context }) => {
        const rows = await deps.prisma.capabilityInstall.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      catalogSearch: authed.capabilities.catalogSearch.handler(async ({ context, input }) => {
        const baseUrl =
          deps.env.integrationsCatalogUrl ??
          (input.usePublicCatalog ? "https://integrations.sh" : undefined);
        if (!baseUrl) return { enabled: false, results: [] };
        try {
          const results = await searchIntegrationCatalog({
            baseUrl,
            query: input.query,
            signal: context.signal ?? new AbortController().signal,
            fetch: deps.remoteConnectors?.fetch,
          });
          return { enabled: true, results };
        } catch (error) {
          throw new ORPCError("BAD_GATEWAY", {
            message: error instanceof Error ? error.message : "Integration catalog search failed",
          });
        }
      }),
      install: authed.capabilities.install.handler(async ({ context, input }) => {
        let source = input.source.trim();
        let config = input.config;
        const credential = input.credential?.trim() || undefined;
        if (
          credential &&
          credential.length >= 8 &&
          (source.includes(credential) || containsSecret(config, [credential]))
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Put credentials only in the encrypted credential field",
          });
        }
        if (JSON.stringify(config).length > 2_000_000) {
          throw new ORPCError("BAD_REQUEST", { message: "Capability configuration is too large" });
        }
        if (
          credential &&
          input.kind !== "mcp" &&
          input.kind !== "api" &&
          input.kind !== "graphql"
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Credentials are only accepted for MCP, API, and GraphQL tool sources",
          });
        }
        try {
          if (input.kind === "mcp") {
            if (config.preset === "treg") {
              source = "https://treg.to/mcp/";
              config = { ...config, preset: "treg", auth: { type: "bearer" } };
            }
            const verified = await verifyMcpInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            config = verified.config;
          }
          if (input.kind === "api") {
            const prepared = await prepareApiInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            source = prepared.source;
            config = prepared.config;
          }
          if (input.kind === "graphql") {
            const prepared = await prepareGraphqlInstall({
              source,
              config,
              credential,
              signal: context.signal,
              remote: deps.remoteConnectors,
            });
            source = prepared.source;
            config = prepared.config;
          }
        } catch (error) {
          const message = sanitizeComposioError(error);
          throw new ORPCError("BAD_REQUEST", {
            message: credential ? message.split(credential).join("[redacted]") : message,
          });
        }
        const stored = credential
          ? await deps.secrets.put(credential, {
              operationId: "capabilities.install",
              traceId: "capabilities.install",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: context.signal ?? new AbortController().signal,
            })
          : undefined;
        const digest = `sha256:${createHash("sha256")
          .update(JSON.stringify({ kind: input.kind, source, config }))
          .digest("hex")}`;
        const row = await deps.prisma.$transaction(async (tx) => {
          if (stored) {
            await tx.secret.create({
              data: {
                id: stored.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "connector",
                ciphertext: stored.ciphertext,
              },
            });
          }
          return tx.capabilityInstall.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              kind: input.kind,
              name: input.name.trim(),
              source,
              secretId: stored?.id,
              config: config as Prisma.InputJsonValue,
              digest,
              version: "1.0.0",
            },
          });
        });
        return {
          id: row.id,
          kind: row.kind as "skill" | "plugin" | "mcp" | "api" | "connection",
          name: row.name,
          source: row.source,
          version: row.version,
          digest: row.digest,
          secretConfigured: Boolean(row.secretId),
          config: row.config as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.capabilities.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction(async (tx) => {
          const existing = await tx.capabilityInstall.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          });
          if (!existing) return;
          await tx.capabilityInstall.delete({ where: { id: existing.id } });
          if (existing.secretId) {
            const shared = await tx.capabilityInstall.count({
              where: { secretId: existing.secretId },
            });
            if (shared === 0) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
          }
        });
        return { ok: true as const };
      }),
    },
    integrations: {
      status: authed.integrations.status.handler(async ({ context, input }) => {
        await integrations.expireConsent(context.actor);
        return connectionDto(await integrations.owned(context.actor, input.connectionId));
      }),
      resourceTools: authed.integrations.resourceTools.handler(({ context, input }) =>
        integrations.resourceTools(context.actor, input.connectionId, input.kind),
      ),
      searchResources: authed.integrations.searchResources.handler(({ context, input }) =>
        integrations.searchResources(context.actor, input),
      ),
      list: authed.integrations.list.handler(({ context }) => integrations.list(context.actor)),
      connect: authed.integrations.connect.handler(({ context, input }) =>
        integrations.connect(context.actor, input),
      ),
      assign: authed.integrations.assign.handler(({ context, input }) =>
        integrations.assign(context.actor, input),
      ),
      grants: authed.integrations.grants.handler(({ context, input }) =>
        integrations.grants(context.actor, input.connectionId),
      ),
      revoke: authed.integrations.revoke.handler(({ context, input }) =>
        integrations.revoke(context.actor, input.connectionId),
      ),
      cancel: authed.integrations.cancel.handler(({ context, input }) =>
        integrations.revoke(context.actor, input.connectionId, "cancelled"),
      ),
      discover: authed.integrations.discover.handler(async ({ context, input }) => {
        await integrations.capture(context.actor, input.connectionId);
        return { ok: true as const };
      }),
    },
    mcp: {
      servers: {
        permissions: authed.mcp.servers.permissions.handler(({ context, input }) =>
          integrations.assign(context.actor, { ...input, connectionId: input.serverId }, "mcp"),
        ),
        tools: authed.mcp.servers.tools.handler(async ({ context, input }) => {
          await integrations.capture(context.actor, input.serverId);
          return IntegrationManifestSchema.parse(
            (await integrations.owned(context.actor, input.serverId)).manifest,
          );
        }),
        list: authed.mcp.servers.list.handler(async ({ context }) => {
          const rows = await deps.prisma.mcpServer.findMany({
            where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
            orderBy: [{ name: "asc" }, { createdAt: "asc" }],
          });
          const secretIds = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
          const secrets = secretIds.length
            ? await deps.prisma.secret.findMany({
                where: {
                  id: { in: secretIds },
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true, ciphertext: true },
              })
            : [];
          const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
          return rows.map((row) => {
            const status = mcpOAuth.statusForCiphertext(
              row.secretId ? ciphertextById.get(row.secretId) : undefined,
              row.secretId ?? undefined,
            );
            return mcpServerDto(row, status.oauthStatus, status.credentialConflict);
          });
        }),
        create: authed.mcp.servers.create.handler(async ({ context, input }) => {
          // The input schema already rejects a server with both a token and a header.
          const secretPayload = buildMcpCredentialBlob(input);
          const stored = secretPayload
            ? await deps.secrets.put(
                secretPayload,
                computerContext(context.actor, "mcp", "mcp.create"),
              )
            : null;
          const row = await deps.prisma.$transaction(async (tx) => {
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            return tx.mcpServer.create({
              data: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                slug: input.slug,
                name: input.name,
                description: input.description,
                transport: input.transport,
                endpoint: "endpoint" in input ? input.endpoint : null,
                command: "command" in input ? input.command : null,
                args: ("args" in input
                  ? redactMcpArguments(input.args, [
                      ...Object.values(input.env),
                      ...(input.secret ? [input.secret] : []),
                    ])
                  : []) as Prisma.InputJsonValue,
                env: ("env" in input
                  ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                headers: ("headers" in input
                  ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
                  : {}) as Prisma.InputJsonValue,
                secretId: stored?.id,
                enabled: input.enabled,
              },
            });
          });
          return mcpServerDto(row, await mcpOAuth.statusFor(row, context.actor));
        }),
        update: authed.mcp.servers.update.handler(async ({ context, input }) => {
          // A token or header on its own replaces the credential, not the definition.
          const credentialOnly = "secret" in input || "headers" in input;
          const row = await deps.prisma.$transaction(async (tx) => {
            // Share the OAuth broker's per-server lock so a stale authorization
            // snapshot cannot overwrite a simultaneous credential edit.
            if (credentialOnly) await lockMcpServerRevision(tx, input.id, context.actor);
            else
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.id}))`;
            const existing = await tx.mcpServer.findFirst({
              where: {
                id: input.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!existing) throw new IsolationError();
            if (existing.managedBy)
              throw new ORPCError("BAD_REQUEST", {
                message: "Manage this server in Extensions or Plugins.",
              });
            if (existing.catalogId)
              throw new ORPCError("BAD_REQUEST", {
                message: "Manage this connection in Integrations.",
              });
            if ("enabled" in input) {
              if (existing.transport === "stdio")
                throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
              await tx.botMcpServer.updateMany({
                where: {
                  serverId: existing.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                data: { needsReview: true, allowAllTools: false, allowedTools: [] },
              });
              return tx.mcpServer.update({
                where: { id: existing.id },
                data: {
                  enabled: input.enabled,
                  connectionState: "not-connected",
                  revision: { increment: 1 },
                },
              });
            }
            const existingSecret = existing.secretId
              ? await tx.secret.findFirst({
                  where: {
                    id: existing.secretId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                })
              : null;
            let existingMaterial: Record<string, unknown> = {};
            if (existingSecret) {
              try {
                const value = JSON.parse(
                  deps.secrets.load(existingSecret.ciphertext, existingSecret.id),
                );
                if (value && typeof value === "object" && !Array.isArray(value))
                  existingMaterial = value as Record<string, unknown>;
              } catch {
                /* Existing malformed secrets are replaced only when new credentials are supplied. */
              }
            }
            const config =
              "config" in input
                ? input.config
                : {
                    slug: existing.slug,
                    name: existing.name,
                    description: existing.description,
                    enabled: existing.enabled,
                    transport: existing.transport as "streamable_http" | "sse",
                    endpoint: existing.endpoint!,
                    // One credential: the new one replaces the other kind, header names included.
                    headers: "headers" in input ? input.headers : {},
                    secret: "secret" in input ? input.secret : undefined,
                  };
            if (!("config" in input) && existing.transport === "stdio") {
              throw new ORPCError("BAD_REQUEST", { message: "A remote MCP server is required" });
            }
            const nextEndpoint = "endpoint" in config ? config.endpoint : null;
            const update = buildMcpUpdateMaterial(existingMaterial, config, {
              clearOAuth: existing.endpoint !== nextEndpoint,
            });
            const stored =
              update.action === "store" && Object.keys(update.material).length > 0
                ? await deps.secrets.put(
                    JSON.stringify(update.material),
                    computerContext(context.actor, "mcp", "mcp.update"),
                  )
                : null;
            const clearing = update.action === "store" && Object.keys(update.material).length === 0;
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: context.actor.userId,
                  spaceId: context.actor.spaceId,
                  kind: "mcp",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            const data = {
              slug: config.slug,
              name: config.name,
              description: config.description,
              transport: config.transport,
              endpoint: nextEndpoint,
              command: "command" in config ? config.command : null,
              args: ("args" in config
                ? redactMcpArguments(config.args, [
                    ...Object.values(config.env),
                    ...(config.secret ? [config.secret] : []),
                  ])
                : []) as Prisma.InputJsonValue,
              env: ("env" in config
                ? Object.fromEntries(Object.keys(config.env).map((key) => [key, true]))
                : {}) as Prisma.InputJsonValue,
              headers: ("headers" in config
                ? Object.fromEntries(Object.keys(config.headers).map((key) => [key, true]))
                : {}) as Prisma.InputJsonValue,
              enabled: config.enabled,
              ...(stored ? { secretId: stored.id } : clearing ? { secretId: null } : {}),
            };
            if (credentialOnly) await bumpMcpServerRevision(tx, existing.id, context.actor, data);
            const updated = credentialOnly
              ? await tx.mcpServer.findFirstOrThrow({ where: { id: existing.id } })
              : await tx.mcpServer.update({
                  where: { id: existing.id },
                  data: { ...data, revision: { increment: 1 } },
                });
            if (stored) {
              if (existing.secretId)
                await tx.secret.deleteMany({
                  where: {
                    id: existing.secretId,
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                  },
                });
            } else if (clearing && existing.secretId) {
              await tx.secret.deleteMany({
                where: {
                  id: existing.secretId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
            }
            return updated;
          });
          return mcpServerDto(row, await mcpOAuth.statusFor(row, context.actor));
        }),
        remove: authed.mcp.servers.remove.handler(async ({ context, input }) => {
          const server = await deps.prisma.mcpServer.findFirst({
            where: {
              id: input.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true, secretId: true, managedBy: true },
          });
          if (!server) throw new IsolationError();
          if (server.managedBy)
            throw new ORPCError("BAD_REQUEST", {
              message: "Manage this server in Extensions or Plugins.",
            });
          // Assignments cascade; the encrypted credential must go with the server.
          await deps.prisma.$transaction([
            deps.prisma.mcpServer.delete({ where: { id: server.id } }),
            ...(server.secretId
              ? [
                  deps.prisma.secret.deleteMany({
                    where: {
                      id: server.secretId,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                    },
                  }),
                ]
              : []),
          ]);
          return { ok: true as const };
        }),
      },
      assignments: {
        all: authed.mcp.assignments.all.handler(async ({ context }) => {
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              bot: { archivedAt: null },
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        list: authed.mcp.assignments.list.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            select: { id: true },
          });
          if (!bot) throw new IsolationError();
          const rows = await deps.prisma.botMcpServer.findMany({
            where: {
              botId: bot.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
            orderBy: { createdAt: "asc" },
          });
          return rows.map(mcpAssignmentDto);
        }),
        approve: authed.mcp.assignments.approve.handler(async ({ context, input }) => {
          const row = await deps.prisma.$transaction(async (tx) => {
            const [bot, server] = await Promise.all([
              tx.bot.findFirst({
                where: {
                  id: input.botId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
                select: { id: true },
              }),
              tx.mcpServer.findFirst({
                where: {
                  id: input.serverId,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  enabled: true,
                },
                select: { id: true },
              }),
            ]);
            if (!bot || !server) throw new IsolationError();
            return tx.botMcpServer.upsert({
              where: { botId_serverId: { botId: bot.id, serverId: server.id } },
              create: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                botId: bot.id,
                serverId: server.id,
                allowAllTools: false,
                needsReview: true,
                allowedTools: [],
              },
              update: {},
            });
          });
          return mcpAssignmentDto(row);
        }),
        replace: authed.mcp.assignments.replace.handler(async ({ context, input }) => {
          const result = await deps.prisma.$transaction(async (tx) => {
            const bot = await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (!bot) throw new IsolationError();
            const servers = await tx.mcpServer.findMany({
              where: {
                id: { in: input.assignments.map((assignment) => assignment.serverId) },
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              select: { id: true },
            });
            if (servers.length !== input.assignments.length) throw new IsolationError();
            await tx.botMcpServer.deleteMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (input.assignments.length)
              await tx.botMcpServer.createMany({
                data: input.assignments.map((assignment) => ({
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                  botId: bot.id,
                  serverId: assignment.serverId,
                  allowAllTools: false,
                  needsReview: assignment.needsReview,
                  allowedTools: assignment.allowedTools as Prisma.InputJsonValue,
                })),
              });
            return tx.botMcpServer.findMany({
              where: {
                botId: bot.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
              orderBy: { createdAt: "asc" },
            });
          });
          return result.map(mcpAssignmentDto);
        }),
      },
      oauth: {
        begin: authed.mcp.oauth.begin.handler(async ({ context, input }) => {
          try {
            const expectedRedirect = new URL("/api/oauth/done", deps.env.webOrigin).toString();
            if (new URL(input.redirectUri).toString() !== expectedRedirect) {
              throw new Error("MCP OAuth redirect URI is not allowed");
            }
            return await integrations.beginAuthorization(context.actor, input);
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not start MCP OAuth",
            });
          }
        }),
        complete: authed.mcp.oauth.complete.handler(async ({ context, input }) => {
          try {
            const serverId = await mcpOAuth.complete({
              ...input,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            });
            await integrations.capture(context.actor, serverId, input.sessionId);
            // A catalog capture records a failed discovery instead of throwing.
            const recorded = await integrations.owned(context.actor, serverId);
            return recorded.connectionState === "connected" && !recorded.lastError
              ? { ok: true as const, result: "connected" as const }
              : { ok: true as const, result: "failed" as const, lastError: recorded.lastError };
          } catch (error) {
            if (error instanceof McpOAuthAttemptReplacedError) {
              return { ok: true as const, result: "replaced" as const };
            }
            await mcpOAuth
              .recordAttemptFailure({
                sessionId: input.sessionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                kind: "failed",
              })
              .catch(() => undefined);
            throw new ORPCError("BAD_REQUEST", {
              message: "Could not complete authorization. Try connecting again.",
            });
          }
        }),
        cancel: authed.mcp.oauth.cancel.handler(async ({ context, input }) => {
          await integrations.cancelAuthorization(context.actor, input);
          return { ok: true as const };
        }),
        disconnect: authed.mcp.oauth.disconnect.handler(async ({ context, input }) => {
          await mcpOAuth.disconnect({
            ...input,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          });
          return { ok: true as const };
        }),
      },
    },
    onboarding: {
      start: authed.onboarding.start.handler(async ({ context, input }) => {
        await startOnboarding(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      promptFocus: authed.onboarding.promptFocus.handler(async ({ context, input }) => {
        await promptFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      choose: authed.onboarding.choose.handler(async ({ context, input }) => {
        await chooseFocus(onboardingDeps, context.actor, input.botId, input.optionId);
        return { ok: true as const };
      }),
      dismissFocus: authed.onboarding.dismissFocus.handler(async ({ context, input }) => {
        await dismissFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      appConnected: authed.onboarding.appConnected.handler(async ({ context, input }) => {
        await markAppConnected(
          onboardingDeps,
          context.actor,
          input.botId,
          input.provider,
          input.connectorId,
        );
        return { ok: true as const };
      }),
    },
    integrationSetup: {
      get: authed.integrationSetup.get.handler(async ({ context }) => {
        const canConfigure = context.actor.isDeploymentOwner;
        const providers = canConfigure
          ? await Promise.all(
              IntegrationProviderIdSchema.options.map(async (id) => ({
                id,
                configured: deps.integrationSettings
                  ? await deps.integrationSettings.configured(id)
                  : Boolean(deps.connectors.managed(id)),
              })),
            )
          : [];
        return {
          canConfigure,
          needsSetup: canConfigure && !providers.some((provider) => provider.configured),
          webUrl: new URL("/integrations/setup", deps.env.webOrigin).toString(),
          providers,
        };
      }),
      save: authed.integrationSetup.save.handler(async ({ context, input }) => {
        if (!context.actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
        if (!deps.integrationSettings) throw new ORPCError("NOT_IMPLEMENTED");
        try {
          await deps.integrationSettings.save(
            input,
            connectionContext(context.actor, "integrationSetup.save", context.signal),
          );
        } catch {
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not verify or save these credentials",
          });
        }
        return { ok: true as const };
      }),
    },
    connections: {
      catalog: authed.connections.catalog.handler(async ({ context, input }) => {
        const adapterContext = connectionContext(
          context.actor,
          "connections.catalog",
          context.signal,
        );
        const providers = input.connectorId
          ? [deps.connectors.managed(input.connectorId)].filter(
              (provider): provider is NonNullable<typeof provider> => Boolean(provider),
            )
          : deps.connectors.managedProviders();
        const catalogs = await Promise.all(
          providers.map(async (provider): Promise<ConnectorCatalogItem[]> => {
            try {
              const items = await provider.catalog(adapterContext, input.query);
              const nowConnected = items.filter((item) => item.connected).map((item) => item.slug);
              if (nowConnected.length > 0) {
                await reconcilePendingConnections(
                  deps.prisma,
                  context.actor,
                  provider.describe().id,
                  nowConnected,
                ).catch((error) => {
                  getLogger().error(
                    `${provider.describe().id} pending-connection reconciliation failed`,
                    error,
                  );
                });
              }
              return items;
            } catch {
              return [];
            }
          }),
        );
        return catalogs.flat();
      }),
      list: authed.connections.list.handler(async ({ context }) => {
        const rows = await deps.prisma.connection.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        return rows.map((row) => ({
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      begin: authed.connections.begin.handler(async ({ context, input }) => {
        const connector =
          deps.integrationSettings &&
          (input.connectorId === "composio" || input.connectorId === "pipedream")
            ? await deps.integrationSettings.resolve(input.connectorId)
            : deps.connectors.managed(input.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${input.connectorId} is not configured`,
          });
        }
        // Share the revoke scope lock so a slug-wide remote delete cannot miss a
        // row that is inserted after SELECT FOR UPDATE and before remote revoke.
        const row = await deps.prisma.$transaction(async (tx) => {
          await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
          const existing = await tx.connection.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: input.connectorId,
              provider: input.provider,
            },
            select: { id: true, status: true },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          });
          const reusable = pickReusableConnection(existing);
          if (reusable) {
            return tx.connection.update({
              where: { id: reusable.id },
              data: {
                displayName: input.displayName,
                status: "pending",
                providerRef: null,
                metadata: {},
              },
            });
          }
          return tx.connection.create({
            data: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: input.connectorId,
              provider: input.provider,
              displayName: input.displayName,
              status: "pending",
            },
          });
        });
        try {
          const auth = await connector.begin(
            { provider: input.provider, redirectUrl: `${deps.env.webOrigin}/app` },
            connectionContext(context.actor, "connections.begin", context.signal),
          );
          // Re-take the provider lock and only advance still-pending rows so a
          // concurrent revoke cannot be overwritten back to pending/connected.
          const applied = await deps.prisma.$transaction(async (tx) => {
            await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
            const updated = await tx.connection.updateMany({
              where: {
                id: row.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "pending",
              },
              data: {
                status: auth.authorizationUrl ? "pending" : "connected",
                providerRef: auth.state || null,
                metadata: { state: auth.state },
              },
            });
            return updated.count > 0;
          });
          if (!applied) {
            // Revoke won the race. Clean up without a provider-wide slug delete.
            const state = auth.state?.trim();
            const adapterContext = connectionContext(
              context.actor,
              "connections.begin",
              context.signal,
            );
            if (state && state !== input.provider) {
              // Composio browser OAuth stores an authorization-request id in
              // auth.state. Prefer canceling that pending request by id so the
              // authorization URL cannot later create an untracked remote. The
              // request id is the connected-account nanoid (INITIATED until OAuth
              // finishes). Fall back to resolving an ACTIVE account id only when
              // cancel is unavailable.
              const cancelAuthorizationRequest = (
                connector as {
                  cancelAuthorizationRequest?: (
                    requestId: string,
                    context: typeof adapterContext,
                  ) => Promise<void>;
                }
              ).cancelAuthorizationRequest;
              if (cancelAuthorizationRequest) {
                await cancelAuthorizationRequest(state, adapterContext).catch(() => undefined);
              } else {
                const resolveAccountId = (
                  connector as {
                    resolveConnectedAccountId?: (
                      userId: string,
                      slug: string,
                      currentRef: string | null | undefined,
                      excludeIds?: string[],
                      spaceId?: string,
                    ) => Promise<string | undefined>;
                  }
                ).resolveConnectedAccountId;
                let revokeRef = state;
                if (resolveAccountId) {
                  const resolved = await resolveAccountId(
                    context.actor.userId,
                    input.provider,
                    state,
                    [],
                    context.actor.spaceId,
                  ).catch(() => undefined);
                  if (!resolved) {
                    revokeRef = "";
                  } else {
                    revokeRef = resolved;
                  }
                }
                if (revokeRef) {
                  await connector.revoke(revokeRef, adapterContext).catch(() => undefined);
                }
              }
            } else if (state === input.provider) {
              // Pipedream begin only returns the app slug. Drop remotes that no
              // remaining local row still references so a lost race cannot leave
              // an orphan authorization, without wiping sibling accounts.
              const revokeUnreferenced = (
                connector as {
                  revokeUnreferencedAccounts?: (
                    slug: string,
                    keepAccountIds: string[],
                    context: ReturnType<typeof connectionContext>,
                  ) => Promise<void>;
                }
              ).revokeUnreferencedAccounts;
              if (revokeUnreferenced) {
                // Hold the provider lock across the keep-id snapshot and remote
                // cleanup so a concurrent complete cannot persist a providerRef
                // that this cleanup then deletes as unreferenced.
                await deps.prisma
                  .$transaction(
                    async (tx) => {
                      await lockProviderConnectionScope(
                        tx,
                        context.actor,
                        input.connectorId,
                        input.provider,
                      );
                      const kept = await tx.connection.findMany({
                        where: {
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                          connectorId: input.connectorId,
                          provider: input.provider,
                          status: { in: ["connected", "pending", "error"] },
                        },
                        select: { providerRef: true },
                      });
                      const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                        kept.map((entry) => entry.providerRef),
                        input.provider,
                      );
                      // Skip while any sibling still lacks a concrete account id —
                      // otherwise slug-only pending refs are dropped from keepIds and
                      // revokeUnreferencedAccounts deletes that sibling's remote auth.
                      if (!canRevokeUnreferenced) return;
                      await revokeUnreferenced(input.provider, keepIds, adapterContext);
                    },
                    { timeout: 60_000 },
                  )
                  .catch(() => undefined);
              }
            }
            throw new IsolationError();
          }
          return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          await deps.prisma.connection.updateMany({
            where: {
              id: row.id,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              status: "pending",
            },
            data: { status: "error" },
          });
          throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
        }
      }),
      complete: authed.connections.complete.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const connector = deps.connectors.managed(existing.connectorId);
        if (!connector) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Connector ${existing.connectorId} is not configured`,
          });
        }
        let row = existing;
        if (existing.status !== "connected") {
          // Hold the provider lock across remote completion, account-id resolution,
          // providerRef persistence, and any overlapping revokeUnreferenced cleanup
          // so a concurrent begin-loss cleanup cannot delete the account we are about
          // to persist.
          row = await deps.prisma.$transaction(
            async (tx) => {
              await lockProviderConnectionScope(
                tx,
                context.actor,
                existing.connectorId,
                existing.provider,
              );
              const current = await tx.connection.findFirst({
                where: {
                  id: existing.id,
                  spaceId: context.actor.spaceId,
                  userId: context.actor.userId,
                },
              });
              if (!current) throw new IsolationError();
              if (current.status === "connected") return current;
              if (current.status === "revoked") {
                // Authorization URLs from a revoke-win begin can still finish
                // remotely. Cancel leftover Composio request ids / drop Pipedream
                // remotes no active local row still references before rejecting.
                const revokedContext = connectionContext(
                  context.actor,
                  "connections.complete",
                  context.signal,
                );
                const restoreRevokedForRetry = async () => {
                  // Cleanup failed while the row is already revoked — restore pending
                  // so the UI can retry removal instead of leaving an orphan remote.
                  // Use the root client (not tx): throwing IsolationError aborts this
                  // transaction and would otherwise roll back a tx-scoped restore.
                  await deps.prisma.connection.updateMany({
                    where: {
                      id: current.id,
                      spaceId: context.actor.spaceId,
                      userId: context.actor.userId,
                      status: "revoked",
                    },
                    data: { status: "pending" },
                  });
                };
                const pendingRef = current.providerRef?.trim();
                try {
                  if (pendingRef && pendingRef !== current.provider) {
                    const cancelAuthorizationRequest = (
                      connector as {
                        cancelAuthorizationRequest?: (
                          requestId: string,
                          context: typeof revokedContext,
                        ) => Promise<void>;
                      }
                    ).cancelAuthorizationRequest;
                    if (cancelAuthorizationRequest) {
                      await cancelAuthorizationRequest(pendingRef, revokedContext);
                    } else {
                      const resolveAccountId = (
                        connector as {
                          resolveConnectedAccountId?: (
                            userId: string,
                            slug: string,
                            currentRef: string | null | undefined,
                            excludeIds?: string[],
                            spaceId?: string,
                          ) => Promise<string | undefined>;
                        }
                      ).resolveConnectedAccountId;
                      let revokeRef = pendingRef;
                      if (resolveAccountId) {
                        const resolved = await resolveAccountId(
                          context.actor.userId,
                          current.provider,
                          pendingRef,
                          [],
                          context.actor.spaceId,
                        ).catch(() => undefined);
                        revokeRef = resolved ?? "";
                      }
                      if (revokeRef) {
                        await connector.revoke(revokeRef, revokedContext);
                      }
                    }
                  } else {
                    const revokeUnreferenced = (
                      connector as {
                        revokeUnreferencedAccounts?: (
                          slug: string,
                          keepAccountIds: string[],
                          context: typeof revokedContext,
                        ) => Promise<void>;
                      }
                    ).revokeUnreferencedAccounts;
                    if (revokeUnreferenced) {
                      const kept = await tx.connection.findMany({
                        where: {
                          spaceId: context.actor.spaceId,
                          userId: context.actor.userId,
                          connectorId: existing.connectorId,
                          provider: existing.provider,
                          status: { in: ["connected", "pending", "error"] },
                        },
                        select: { providerRef: true },
                      });
                      const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
                        kept.map((entry) => entry.providerRef),
                        existing.provider,
                      );
                      if (canRevokeUnreferenced) {
                        await revokeUnreferenced(existing.provider, keepIds, revokedContext);
                      }
                    }
                  }
                } catch (error) {
                  getLogger().error(
                    "connections.complete remote cleanup failed for revoked row",
                    error,
                    {
                      connectionId: current.id,
                      connectorId: existing.connectorId,
                      provider: existing.provider,
                    },
                  );
                  await restoreRevokedForRetry();
                }
                throw new IsolationError();
              }

              const adapterContext = connectionContext(
                context.actor,
                "connections.complete",
                context.signal,
              );
              if (input.code) {
                const state = current.providerRef ?? current.provider;
                try {
                  await connector.complete({ state, code: input.code }, adapterContext);
                } catch (error) {
                  throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
                }
              }
              const ready = await connector.connectionReady(adapterContext, current.provider);
              if (!ready) return current;

              // Browser OAuth stores a connection-request id in providerRef from
              // begin. Resolve it to the connected-account id so revoke deletes the
              // right remote authorization. Prefer an account id not already used
              // by a sibling row for the same provider.
              const resolveAccountId = (
                connector as {
                  resolveConnectedAccountId?: (
                    userId: string,
                    slug: string,
                    currentRef: string | null | undefined,
                    excludeIds?: string[],
                    spaceId?: string,
                  ) => Promise<string | undefined>;
                  connectedAccountId?: (
                    userId: string,
                    slug: string,
                  ) => Promise<string | undefined>;
                }
              ).resolveConnectedAccountId;
              const fallbackAccountId = (
                connector as {
                  connectedAccountId?: (
                    userId: string,
                    slug: string,
                  ) => Promise<string | undefined>;
                }
              ).connectedAccountId;
              let resolvedAccountId: string | undefined;
              if (resolveAccountId || fallbackAccountId) {
                const siblings = await tx.connection.findMany({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    id: { not: existing.id },
                    status: { in: ["connected", "pending", "error"] },
                  },
                  select: { providerRef: true },
                });
                // Exclude concrete account ids only. A pending sibling may still
                // store a slug or authorization-request id; passing those raw refs
                // would not match remote account ids and can let this row adopt the
                // sibling's account. If a sibling ref cannot be resolved yet, leave
                // this row pending so a later complete can re-resolve safely.
                const excludeIds: string[] = [];
                let unresolvedSibling = false;
                for (const sibling of siblings) {
                  const ref = sibling.providerRef?.trim();
                  // Slug-only refs cannot identify a concrete remote account; resolving
                  // them would pick an arbitrary ACTIVE id and over-exclude.
                  if (!ref || ref === existing.provider) continue;
                  if (resolveAccountId) {
                    const resolvedSiblingId = await resolveAccountId(
                      context.actor.userId,
                      existing.provider,
                      ref,
                      [],
                      context.actor.spaceId,
                    ).catch(() => undefined);
                    if (resolvedSiblingId) {
                      excludeIds.push(resolvedSiblingId);
                    } else {
                      unresolvedSibling = true;
                    }
                  } else {
                    excludeIds.push(ref);
                  }
                }
                if (unresolvedSibling) {
                  return current;
                }
                resolvedAccountId = resolveAccountId
                  ? await resolveAccountId(
                      context.actor.userId,
                      existing.provider,
                      current.providerRef,
                      excludeIds,
                      context.actor.spaceId,
                    ).catch(() => undefined)
                  : await fallbackAccountId!(context.actor.userId, existing.provider).catch(
                      () => undefined,
                    );
              }

              // When a resolver exists and providerRef is still a request-scoped
              // id (not the provider slug), require a concrete account id before
              // marking connected — otherwise revoke would delete the wrong ref.
              if (
                resolveAccountId &&
                current.providerRef &&
                current.providerRef !== current.provider &&
                !resolvedAccountId
              ) {
                return current;
              }

              const providerRef = resolvedAccountId ?? current.providerRef;
              if (providerRef) {
                const taken = await tx.connection.findFirst({
                  where: {
                    spaceId: context.actor.spaceId,
                    userId: context.actor.userId,
                    connectorId: existing.connectorId,
                    provider: existing.provider,
                    id: { not: existing.id },
                    status: { in: ["connected", "pending", "error"] },
                    providerRef,
                  },
                  select: { id: true },
                });
                if (taken) {
                  // Do not mark connected with a request-scoped or shared ref —
                  // leave pending so a later complete can re-resolve an unused id.
                  return current;
                }
              }
              return tx.connection.update({
                where: { id: current.id },
                data: {
                  status: "connected",
                  ...(providerRef ? { providerRef } : {}),
                },
              });
            },
            { timeout: 60_000 },
          );
        }
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      rename: authed.connections.rename.handler(async ({ context, input }) => {
        const existing = await deps.prisma.connection.findFirst({
          where: {
            id: input.connectionId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!existing) throw new IsolationError();
        const row = await deps.prisma.connection.update({
          where: { id: existing.id },
          data: { displayName: input.displayName },
        });
        return {
          id: row.id,
          connectorId: row.connectorId,
          provider: row.provider,
          displayName: row.displayName,
          status: row.status as "pending" | "connected" | "revoked" | "error",
          capabilities: [],
          createdAt: row.createdAt.toISOString(),
        };
      }),
      revoke: authed.connections.revoke.handler(async ({ context, input }) => {
        type RemoteRevoke = {
          connectorId: string;
          connectionRef: string;
          accountSpecific: boolean;
        };
        const outcome = await deps.prisma.$transaction(
          async (tx) => {
            const row = await tx.connection.findFirst({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
              },
            });
            if (!row) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
            // alone misses a concurrent begin that inserts after the lock query.
            await lockProviderConnectionScope(tx, context.actor, row.connectorId, row.provider);
            await tx.$queryRaw`
              SELECT id
              FROM connections
              WHERE "spaceId" = ${context.actor.spaceId}
                AND "userId" = ${context.actor.userId}
                AND "connectorId" = ${row.connectorId}
                AND provider = ${row.provider}
                AND status IN ('connected', 'pending', 'error')
              FOR UPDATE`;

            const updated = await tx.connection.updateMany({
              where: {
                id: row.id,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: { in: ["connected", "pending", "error"] },
              },
              data: { status: "revoked" },
            });
            if (updated.count === 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            const remaining = await tx.connection.count({
              where: {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                connectorId: row.connectorId,
                provider: row.provider,
                status: { in: ["connected", "pending"] },
              },
            });
            const connectionRef = row.providerRef || row.provider;
            const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
            // Account-scoped refs can disconnect one remote authorization while
            // siblings remain. Slug-only legacy rows must wait until they are last,
            // or a provider-wide revoke would drop every account for that app.
            if (!accountSpecific && remaining > 0) {
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            // Slug-only remote delete is provider-wide. Run it before commit while
            // still holding the begin/revoke lock so a new authorization cannot be
            // created and then wiped by Pipedream's slug-scoped DELETE.
            if (!accountSpecific) {
              const connector = deps.connectors.managed(row.connectorId);
              if (!connector) {
                throw new ORPCError("BAD_REQUEST", {
                  message: `Connector ${row.connectorId} is not configured`,
                });
              }
              try {
                // Abort before the 60s Prisma transaction timeout so a late remote
                // delete cannot succeed after local status has already rolled back.
                const signals = [AbortSignal.timeout(45_000)];
                if (context.signal) signals.unshift(context.signal);
                const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
                await connector.revoke(
                  connectionRef,
                  connectionContext(context.actor, "connections.revoke", revokeSignal),
                );
              } catch (error) {
                if (error instanceof ORPCError) throw error;
                throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
              }
              return {
                remote: null as null | RemoteRevoke,
                previousStatus: null as string | null,
              };
            }

            return {
              remote: {
                connectorId: row.connectorId,
                connectionRef,
                accountSpecific,
              },
              previousStatus: row.status,
            };
          },
          { timeout: 60_000 },
        );

        if (outcome.remote) {
          const restoreLocalStatus = async () => {
            // Local row was marked revoked inside the transaction; restore it so a
            // failed remote disconnect remains retryable instead of orphaned.
            if (!outcome.previousStatus) return;
            await deps.prisma.connection.updateMany({
              where: {
                id: input.connectionId,
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                status: "revoked",
              },
              data: { status: outcome.previousStatus },
            });
          };
          try {
            const connector = deps.connectors.managed(outcome.remote.connectorId);
            if (!connector) {
              throw new ORPCError("BAD_REQUEST", {
                message: `Connector ${outcome.remote.connectorId} is not configured`,
              });
            }
            await connector.revoke(
              outcome.remote.connectionRef,
              connectionContext(context.actor, "connections.revoke", context.signal),
            );
          } catch (error) {
            // Restore when DELETE clearly did not run (including pre-delete list
            // timeouts). Post-delete timeouts stay ambiguous — leave revoked.
            if (shouldRestoreLocalAfterRemoteRevokeFailure(error)) {
              await restoreLocalStatus();
            } else {
              getLogger().error(
                "connections.revoke remote outcome uncertain; leaving local revoked",
                error,
                {
                  connectionId: input.connectionId,
                  connectorId: outcome.remote.connectorId,
                },
              );
            }
            if (error instanceof ORPCError) throw error;
            throw new ORPCError("BAD_REQUEST", { message: sanitizeComposioError(error) });
          }
        }
        return { ok: true as const };
      }),
      tools: authed.connections.tools.handler(async ({ context, input }) => {
        const connector = deps.connectors.managed(input.connectorId);
        if (!connector) return [];
        const row = await deps.prisma.connection.findFirst({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: input.connectorId,
            provider: input.provider,
            status: "connected",
          },
        });
        if (!row) return [];
        try {
          const tools = await connector.discoverTools({
            ...connectionContext(context.actor, "connections.tools", context.signal),
            connectedConnections: [
              {
                id: row.id,
                connectorId: input.connectorId,
                externalId: input.provider,
                displayName: row.displayName,
                providerRef: row.providerRef ?? undefined,
              },
            ],
            connectedProviders: [input.provider],
          });
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
        } catch (error) {
          getLogger().error("connections.tools failed", error, {
            connectorId: input.connectorId,
            provider: input.provider,
          });
          return [];
        }
      }),
    },
    messaging: {
      status: authed.messaging.status.handler(async ({ context }) => {
        const identities = await deps.prisma.messagingIdentity.findMany({
          where: { userId: context.actor.userId },
          orderBy: { createdAt: "asc" },
        });
        return {
          enabled: deps.messaging?.enabled ?? false,
          providers: deps.messaging?.providers ?? [],
          openSignup: deps.messaging?.openSignup ?? false,
          identities: await Promise.all(
            identities.map((identity) => messagingIdentityDto(deps.prisma, identity)),
          ),
        };
      }),
      link: {
        start: authed.messaging.link.start.handler(async ({ context, input }) => {
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          // One chat identity per bot: delivery mirrors a bot's replies to
          // exactly one conversation.
          const linked = await deps.prisma.messagingIdentity.findUnique({
            where: { botId: bot.id },
            select: { id: true },
          });
          if (linked) {
            throw new ORPCError("BAD_REQUEST", {
              message: "That bot is already linked to a chat app; unlink it first.",
            });
          }
          const issued = await issueMessagingLinkCode(deps.prisma, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            botId: bot.id,
          });
          return {
            code: formatMessagingLinkCode(issued.code),
            expiresAt: issued.expiresAt.toISOString(),
          };
        }),
      },
      identities: {
        setBot: authed.messaging.identities.setBot.handler(async ({ context, input }) => {
          const identity = await deps.prisma.messagingIdentity.findFirst({
            where: { id: input.identityId, userId: context.actor.userId },
          });
          if (!identity) throw new ORPCError("NOT_FOUND");
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          try {
            const updated = await deps.prisma.messagingIdentity.update({
              where: { id: identity.id },
              // The identity must live in the bot's space: runs resolve
              // credentials, memory, and approval rules from run.spaceId.
              data: { botId: bot.id, spaceId: context.actor.spaceId },
            });
            return messagingIdentityDto(deps.prisma, updated);
          } catch (error) {
            // botId is unique: the target bot is already linked elsewhere.
            if (isUniqueViolation(error)) {
              throw new ORPCError("BAD_REQUEST", {
                message: "That bot is already linked to a chat app.",
              });
            }
            throw error;
          }
        }),
        unlink: authed.messaging.identities.unlink.handler(async ({ context, input }) => {
          const { count } = await deps.prisma.messagingIdentity.deleteMany({
            where: { id: input.identityId, userId: context.actor.userId },
          });
          if (count === 0) throw new ORPCError("NOT_FOUND");
          return { ok: true as const };
        }),
      },
      channels: {
        list: authed.messaging.channels.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const memberships = await deps.prisma.messagingChannelMember.findMany({
            where: { identityId: { in: identities.map((identity) => identity.id) } },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
            orderBy: { updatedAt: "desc" },
          });
          return memberships.map((membership) => messagingChannelDto(membership));
        }),
        respond: authed.messaging.channels.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
                include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
              })
            : null;
          if (membership?.status !== "invited") {
            throw new ORPCError("NOT_FOUND");
          }
          const { count } = await deps.prisma.messagingChannelMember.updateMany({
            where: { id: membership.id, status: "invited" },
            data: { status: input.accept ? "approved" : "declined" },
          });
          if (count === 0) {
            // Lost a race with leave/sweep: approval must not resurrect a
            // departed member.
            throw new ORPCError("NOT_FOUND");
          }
          const updated = await deps.prisma.messagingChannelMember.findUniqueOrThrow({
            where: { id: membership.id },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
          });
          return messagingChannelDto(updated);
        }),
        leave: authed.messaging.channels.leave.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
              })
            : null;
          if (!membership) throw new ORPCError("NOT_FOUND");
          await deps.prisma.messagingChannelMember.update({
            where: { id: membership.id },
            data: { status: "left" },
          });
          return { ok: true as const };
        }),
      },
      connections: {
        list: authed.messaging.connections.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const botIds = identities.map((identity) => identity.botId);
          const connections = await deps.prisma.agentConnection.findMany({
            where: {
              OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
            },
            orderBy: { updatedAt: "desc" },
          });
          const myBotIds = new Set(botIds);
          return Promise.all(
            connections.map((connection) =>
              messagingConnectionDto(deps.prisma, myBotIds, connection),
            ),
          );
        }),
        respond: authed.messaging.connections.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const myBotIds = new Set(identities.map((identity) => identity.botId));
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  targetBotId: { in: [...myBotIds] },
                  status: "pending",
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          const { updated, notifyRequester } = await deps.prisma.$transaction(async (tx) => {
            // The claim holds the connection row lock through commit, so a
            // revoke either beats it or waits — it can never interleave with
            // the confirmation write below.
            const { count } = await tx.agentConnection.updateMany({
              where: { id: connection.id, status: "pending" },
              data: { status: input.accept ? "approved" : "declined" },
            });
            if (count === 0) {
              // Lost a race with revoke: approval must never overwrite it.
              throw new ORPCError("NOT_FOUND");
            }
            const row = await tx.agentConnection.findUniqueOrThrow({
              where: { id: connection.id },
            });
            if (!input.accept) return { updated: row, notifyRequester: false };
            // Parity with the text-command path: the requester hears about it.
            const requesterIdentity = await tx.messagingIdentity.findUnique({
              where: { botId: connection.requesterBotId },
            });
            if (!requesterIdentity) return { updated: row, notifyRequester: false };
            const key = `command:connected:${connection.id}`;
            // A re-approved pair starts a fresh cycle; clear the stale row or
            // skipDuplicates would swallow the new confirmation.
            await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
            await tx.messagingOutbound.createMany({
              data: [
                {
                  idempotencyKey: key,
                  kind: "dm",
                  identityId: requesterIdentity.id,
                  body: "Your connection request was accepted. Your agents can now message each other.",
                },
              ],
              skipDuplicates: true,
            });
            return { updated: row, notifyRequester: true };
          });
          if (notifyRequester) {
            await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
              getLogger().error("messaging connection confirmation enqueue error", error);
            });
          }
          return messagingConnectionDto(deps.prisma, myBotIds, updated);
        }),
        revoke: authed.messaging.connections.revoke.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const botIds = identities.map((identity) => identity.botId);
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          // Claim + invite cancel in one transaction. The status update holds
          // the connection row lock through commit, so a concurrent reconnect
          // (FOR UPDATE) waits until both the revoke and the invite delete
          // finish — otherwise it could reopen and create a fresh invite that
          // a post-commit deleteMany would then wipe while leaving the row
          // pending with no approval prompt.
          await deps.prisma.$transaction(async (tx) => {
            const { count } = await tx.agentConnection.updateMany({
              where: { id: connection.id, status: connection.status },
              data: { status: "revoked" },
            });
            if (count === 0) throw new ORPCError("NOT_FOUND");
            // Cancel undelivered invites, including rows the drain already
            // claimed (status sent, no providerHandle yet). Connect-invite
            // delivery holds this connection row FOR UPDATE through
            // sendDirect, so revoke either waits until the DM is sent or
            // deletes the claim before send starts.
            await tx.messagingOutbound.deleteMany({
              where: {
                idempotencyKey: `connect:${connection.requesterBotId}:${connection.targetBotId}`,
                OR: [{ status: "pending" }, { status: "sent", providerHandle: null }],
              },
            });
          });
          return { ok: true as const };
        }),
      },
    },
    externalConversations: {
      updatePolicy: authed.externalConversations.updatePolicy.handler(
        async ({ context, input }) => {
          const { externalConversationId, ...policy } = input;
          return createExternalConversationRepos(deps.prisma).updatePolicy(
            context.actor,
            externalConversationId,
            policy,
          );
        },
      ),
    },
    agentSecrets: {
      list: authed.agentSecrets.list.handler(async ({ context }) =>
        listAgentSecrets({ prisma: deps.prisma, secrets: deps.secrets }, context.actor),
      ),
      put: authed.agentSecrets.put.handler(async ({ context, input, signal }) =>
        putAgentSecret(
          { prisma: deps.prisma, secrets: deps.secrets },
          context.actor,
          input,
          signal,
        ),
      ),
      remove: authed.agentSecrets.remove.handler(async ({ context, input }) =>
        deleteAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input.id),
      ),
    },
    approvalRules: {
      list: authed.approvalRules.list.handler(async ({ context }) => {
        const rows = await deps.prisma.actionApprovalRule.findMany({
          where: {
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
          },
          orderBy: { createdAt: "asc" },
        });
        return rows.map((row) => ({
          id: row.id,
          effect: row.effect as "always_allow" | "require_approval",
          matchKind: row.matchKind as "tool" | "connector" | "category",
          matchValue: row.matchValue,
          botId: row.botId,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      set: authed.approvalRules.set.handler(async ({ context, input }) => {
        if (input.botId) await learning.assertBot(context.actor, input.botId);
        const row = await deps.prisma.actionApprovalRule.upsert({
          where: {
            spaceId_createdByUserId_effect_matchKind_matchValue_scopeKey: {
              spaceId: context.actor.spaceId,
              createdByUserId: context.actor.userId,
              effect: input.effect,
              matchKind: input.matchKind,
              matchValue: input.matchValue,
              scopeKey: input.botId ? `bot:${input.botId}` : "all",
            },
          },
          create: {
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
            effect: input.effect,
            matchKind: input.matchKind,
            matchValue: input.matchValue,
            botId: input.botId,
            scopeKey: input.botId ? `bot:${input.botId}` : "all",
          },
          update: {},
        });
        return {
          id: row.id,
          effect: row.effect as "always_allow" | "require_approval",
          matchKind: row.matchKind as "tool" | "connector" | "category",
          matchValue: row.matchValue,
          botId: row.botId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      remove: authed.approvalRules.remove.handler(async ({ context, input }) => {
        await deps.prisma.actionApprovalRule.deleteMany({
          where: {
            id: input.id,
            spaceId: context.actor.spaceId,
            createdByUserId: context.actor.userId,
          },
        });
        return { ok: true as const };
      }),
    },
    autoReview: {
      get: authed.autoReview.get.handler(async ({ context }) => {
        return loadAutoReviewSettings(deps, context.actor);
      }),
      set: authed.autoReview.set.handler(async ({ context, input }) => {
        await deps.prisma.actionAutoReviewPreference.upsert({
          where: {
            spaceId_userId: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
            },
          },
          create: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            enabled: input.enabled,
          },
          update: { enabled: input.enabled },
        });
        return loadAutoReviewSettings(deps, context.actor);
      }),
    },
    artifacts: {
      uploaded: authed.artifacts.uploaded.handler(({ context, input }) =>
        listUploadedFiles(deps.prisma, context.actor, input.cursor),
      ),
      deleteUploaded: authed.artifacts.deleteUploaded.handler(({ context, input }) =>
        deleteUploadedFile(deps, context.actor, input.artifactId),
      ),
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: {
            botId: input.botId,
            groupId: null,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          groupId: row.groupId,
          runId: row.runId,
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      create: authed.artifacts.create.handler(async ({ context, input }) => {
        const botId = input.botId
          ? (await repos.getBot(context.actor, input.botId)).id
          : (await groupRepos.getGroupTarget(context.actor, input.groupId!)).members[0]?.bot.id;
        if (!botId) throw new IsolationError();
        try {
          return await createOwnedArtifact(deps, context.actor, { ...input, botId });
        } catch (error) {
          if (error instanceof AttachmentValidationError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      get: authed.artifacts.get.handler(async ({ context, input }) => {
        if (input.groupId) {
          const group = await groupRepos.getGroupTarget(context.actor, input.groupId);
          const contextBotId = group.members[0]?.bot.id;
          if (!contextBotId) throw new IsolationError();
          return getSpaceArtifact(deps, context.actor, {
            artifactId: input.artifactId,
            groupId: input.groupId,
            contextBotId,
          });
        }
        await repos.getBot(context.actor, input.botId!);
        try {
          return await getOwnedArtifact(deps, context.actor, {
            botId: input.botId!,
            artifactId: input.artifactId,
          });
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          throw error;
        }
      }),
    },
    usage: {
      list: authed.usage.list.handler(async ({ context }) => {
        const rows = await deps.prisma.usageRecord.findMany({
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          delegationId: row.delegationId,
          rootTaskId: row.rootTaskId,
          requesterBotId: row.requesterBotId,
          actingBotId: row.actingBotId,
          depth: row.depth,
          cost: row.pricingProvenance ? row.cost : null,
          pricingProvenance: row.pricingProvenance,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      summary: authed.usage.summary.handler(({ context }) =>
        usageSummary(deps.prisma, context.actor),
      ),
    },
    export: {
      comparison: authed.export.comparison.handler(({ context, input }) =>
        comparisons.export(context.actor, input.id),
      ),
      bot: authed.export.bot.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return exportDownload(context.actor, input.botId);
      }),
      account: authed.export.account.handler(({ context }) => exportDownload(context.actor)),
    },

    notifications: {
      activity: authed.notifications.activity.handler(({ context }) =>
        notificationActivity(deps.prisma, context.actor),
      ),
      capabilities: authed.notifications.capabilities.handler(async ({ context }) => ({
        dispatchPush: Boolean(await loadPushToken(deps.dataDir, context.actor.userId)),
      })),
      registerPush: authed.notifications.registerPush.handler(async ({ context, input }) => {
        await savePushToken(deps.dataDir, context.actor.userId, input.token);
        return { ok: true as const };
      }),
      unregisterPush: authed.notifications.unregisterPush.handler(async ({ context }) => {
        await deletePushToken(deps.dataDir, context.actor.userId);
        return { ok: true as const };
      }),
    },
    search: {
      query: authed.search.query.handler(async ({ context, input }) => ({
        hits: await querySpaceSearch(deps.prisma, context.actor, input.q),
      })),
    },
    comparisons: {
      previewMerge: authed.comparisons.previewMerge.handler(({ context, input }) =>
        comparisons.previewMerge(context.actor, input),
      ),
      preview: authed.comparisons.preview.handler(({ context, input }) =>
        comparisons.preview(context.actor, input),
      ),
      create: authed.comparisons.create.handler(({ context, input }) =>
        comparisons.create(context.actor, input),
      ),
      get: authed.comparisons.get.handler(({ context, input }) =>
        comparisons.get(context.actor, input.id),
      ),
      list: authed.comparisons.list.handler(({ context }) => comparisons.list(context.actor)),
      merge: authed.comparisons.merge.handler(({ context, input }) =>
        comparisons.merge(context.actor, input),
      ),
    },
    dashboard: {
      now: authed.dashboard.now.handler(({ context }) => dashboardNow(deps.prisma, context.actor)),
      connections: authed.dashboard.connections.handler(async ({ context }) => {
        const actor = context.actor;
        const scope = { userId: actor.userId, spaceId: actor.spaceId };
        const [catalog, servers, devices, identities] = await Promise.all([
          integrations.list(actor),
          deps.prisma.mcpServer.findMany({ where: scope, orderBy: { name: "asc" } }),
          deps.prisma.deviceGrant.findMany({
            where: scope,
            select: { id: true, deviceName: true, kind: true, revokedAt: true },
          }),
          deps.prisma.messagingIdentity.findMany({ where: scope, select: { id: true } }),
        ]);
        const channels = identities.length
          ? await deps.prisma.messagingChannelMember.findMany({
              where: { identityId: { in: identities.map((identity) => identity.id) } },
              include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
              orderBy: { updatedAt: "desc" },
            })
          : [];
        return connectionOverview({
          integrations: catalog,
          servers: await Promise.all(
            servers.map(async (server) => ({
              id: server.id,
              name: server.name,
              enabled: server.enabled,
              oauthStatus: await mcpOAuth.statusFor(server, actor),
            })),
          ),
          devices: devices.map((device) => ({
            ...device,
            kind: device.kind === "channel" ? ("channel" as const) : ("device" as const),
            revokedAt: device.revokedAt?.toISOString() ?? null,
          })),
          channels: channels.map((channel) => messagingChannelDto(channel)),
        });
      }),
    },
    features: {
      list: authed.features.list.handler(({ context }) =>
        listSpaceFeatures(deps.prisma, context.actor),
      ),
      set: authed.features.set.handler(({ context, input }) =>
        setSpaceFeature(deps.prisma, context.actor, input),
      ),
    },
    board: {
      view: authed.board.view.handler(({ context, input }) =>
        boardCall(() => board.view(context.actor, input)),
      ),
      work: authed.board.work.handler(({ context }) => boardCall(() => board.work(context.actor))),
      configure: authed.board.configure.handler(({ context, input }) =>
        boardCall(() => board.service.configure(context.actor, input.workspaceId, input.patch)),
      ),
      follow: authed.board.follow.handler(({ context, input }) =>
        boardCall(() => board.follow(context.actor, input)),
      ),
      workspaces: authed.board.workspaces.handler(({ context }) =>
        boardCall(() => board.service.workspaces(context.actor)),
      ),
      start: authed.board.start.handler(({ context, input }) =>
        boardCall(() => board.service.start(context.actor, input.workspaceId)),
      ),
      snapshot: authed.board.snapshot.handler(({ context, input }) =>
        boardCall(() => board.snapshot(context.actor, input)),
      ),
      send: authed.board.send.handler(async ({ context, input }) => {
        if ((await modelSetup(deps, context.actor)).needsModel)
          throw new ORPCError("BAD_REQUEST", { message: "Connect a model to start a run." });
        return boardCall(() => board.send(context.actor, input));
      }),
      show: authed.board.show.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).show(input.id),
        ),
      ),
      create: authed.board.create.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).create(input.item),
        ),
      ),
      update: authed.board.update.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).update(
            input.id,
            input.patch,
          ),
        ),
      ),
      claim: authed.board.claim.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).claim(
            input.id,
            await board.service.actor(context.actor),
          ),
        ),
      ),
      close: authed.board.close.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).close(
            input.ids,
            input.reason,
          ),
        ),
      ),
      comment: authed.board.comment.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).comment(
            input.id,
            input.text,
          ),
        ),
      ),
      graph: authed.board.graph.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).graph(input.rootId),
        ),
      ),
      export: authed.board.export.handler(({ context, input }) =>
        boardCall(async () =>
          (await board.service.provider(context.actor, input.workspaceId)).export(),
        ),
      ),
      link: authed.board.link.handler(({ context, input }) =>
        boardCall(async () => {
          await (await board.service.provider(context.actor, input.workspaceId)).link(
            input.from,
            input.to,
            input.type,
          );
          return { ok: true as const };
        }),
      ),
      upkeep: authed.board.upkeep.handler(({ context }) =>
        boardCall(() => board.service.upkeep(context.actor)),
      ),
      setUpkeep: authed.board.setUpkeep.handler(({ context, input }) =>
        boardCall(() => board.service.setUpkeep(context.actor, input.enabled)),
      ),
    },
    team: {
      board: authed.team.board.handler(({ context }) => teamBoard(deps.prisma, context.actor)),
    },
    delegations: {
      accept: authed.delegations.accept.handler(({ context, input }) =>
        acceptTeamTask(deps.prisma, context.actor, input.id),
      ),
      list: authed.delegations.list.handler(async ({ context, input }) => ({
        delegations: await listDelegations(deps.prisma, context.actor, input.rootTaskId),
      })),
      cancel: authed.delegations.cancel.handler(async ({ context, input }) =>
        requestCancel(
          deps.prisma,
          { spaceId: context.actor.spaceId, userId: context.actor.userId },
          input.rootTaskId,
        ),
      ),
      policy: authed.delegations.policy.handler(({ context, input }) =>
        getModelDestinations(deps.prisma, context.actor, input.botId),
      ),
      setPolicy: authed.delegations.setPolicy.handler(({ context, input }) =>
        setModelDestinations(deps.prisma, context.actor, input),
      ),
    },
    runs: {
      list: authed.runs.list.handler(async ({ context, input }) => ({
        runs: await listSpaceRuns(deps.prisma, context.actor, input.filter),
      })),
    },
    voice: {
      catalog: authed.voice.catalog.handler(async () => listVoiceCatalog()),
      status: authed.voice.status.handler(async ({ context }) => {
        const cred = await findDefaultVoiceCredential(deps.prisma, context.actor);
        return toVoiceStatus(cred);
      }),
      credentials: authed.voice.credentials.handler(async ({ context }) => {
        const rows = await deps.prisma.userVoiceCredential.findMany({
          where: { userId: context.actor.userId },
          include: {
            preferences: {
              where: { userId: context.actor.userId, spaceId: context.actor.spaceId },
            },
          },
          orderBy: newestVoiceCredentialOrder,
        });
        return rows.map((row) => {
          const preference = row.preferences[0];
          return toVoiceCredential({
            ...row,
            isDefault: preference?.isDefault ?? false,
            voiceId: preference?.voiceId ?? "",
          });
        });
      }),
      connect: authed.voice.connect.handler(async ({ context, input }) =>
        persistVoiceCredential(deps, context.actor, {
          provider: input.provider,
          plaintext: input.apiKey,
          voiceId: input.voiceId,
          signal: context.signal,
        }),
      ),
      disconnect: authed.voice.disconnect.handler(async ({ context, input }) =>
        disconnectVoiceCredential(deps, context.actor, { provider: input.provider }),
      ),
      setVoice: authed.voice.setVoice.handler(async ({ context, input }) => {
        const cred = await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const found = input.provider
                ? await tx.userVoiceCredential.findFirst({
                    where: { userId: context.actor.userId, provider: input.provider },
                    orderBy: newestVoiceCredentialOrder,
                  })
                : (
                    await tx.spaceVoicePreference.findFirst({
                      where: {
                        userId: context.actor.userId,
                        spaceId: context.actor.spaceId,
                        isDefault: true,
                      },
                      include: { credential: true },
                      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
                    })
                  )?.credential;
              if (!found) {
                throw new ORPCError("BAD_REQUEST", { message: "Connect a voice provider first." });
              }
              // Picking a voice also makes its provider the one speak/transcribe use.
              await selectSpaceVoicePreference(tx, context.actor, found.id, input.voiceId);
              return { ...found, voiceId: input.voiceId, isDefault: true };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        return toVoiceStatus(cred);
      }),
      voices: authed.voice.voices.handler(async ({ context, input }) => {
        const loaded = await loadDefaultVoiceCredential(deps, context.actor);
        if (!loaded) return [];
        const providerId = input.provider ?? loaded.cred.provider;
        const row =
          providerId === loaded.cred.provider
            ? loaded
            : await loadVoiceCredential(deps, context.actor, providerId);
        if (!row) return [];
        return createVoiceProvider(row.cred.provider).listVoices(
          row.apiKey,
          voiceContext(context.actor, context.signal),
        );
      }),
      prepare: authed.voice.prepare.handler(async ({ context, input }) =>
        prepareVoice(deps, context.actor, input),
      ),
    },
  });
}

function updaterConfig(deps: RouterDeps): UpdaterProxyConfig {
  return {
    url: deps.env.updaterUrl ?? null,
    token: deps.env.updaterToken ?? null,
    gitSha: deps.env.gitSha,
    imageTag: deps.env.imageTag ?? null,
  };
}

function mapUpdaterError(error: unknown): never {
  if (error instanceof UpdaterProxyError) {
    if (error.status === 401 || error.status === 403) {
      throw new ORPCError("FORBIDDEN", { message: error.message });
    }
    if (error.status >= 500) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: error.message });
    }
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    message: error instanceof Error ? error.message : "Update failed.",
  });
}

async function spaceNavigationDto(
  deps: RouterDeps,
  actor: Actor,
  repos: ReturnType<typeof createRepos>,
  groupRepos: ReturnType<typeof createGroupRepos>,
): Promise<SpaceNavigation> {
  const currentSpace = await deps.prisma.space.findUnique({
    where: { id: actor.spaceId },
    select: { organizationId: true },
  });
  if (!currentSpace) throw new IsolationError();
  const memberships = await deps.prisma.spaceMember.findMany({
    where: { userId: actor.userId, organizationId: currentSpace.organizationId },
    select: {
      spaceId: true,
      role: true,
      space: { select: { name: true, isDefault: true, deletingAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const spaceIds = memberships.map((membership) => membership.spaceId);
  const inactiveSpaceIds = spaceIds.filter((spaceId) => spaceId !== actor.spaceId);
  const [
    currentBots,
    currentGroups,
    inactiveBots,
    inactiveGroups,
    botSections,
    externalConversations,
    contentBots,
    contentGroups,
  ] = await Promise.all([
    repos.listBots(actor),
    groupRepos.listGroups(actor),
    repos.listSpaceBotsForSpaces(actor, inactiveSpaceIds),
    groupRepos.listSpaceGroupsForSpaces(actor, inactiveSpaceIds),
    repos.listBotSectionsForSpaces(actor, spaceIds),
    createExternalConversationRepos(deps.prisma).listForSpaces(actor, spaceIds),
    // Active-only navigation lists miss archived content in other spaces; count any
    // bot/group in the actor's spaces (including another member's) so a shared
    // non-empty space cannot look empty for onboarding redirects.
    deps.prisma.bot.findMany({
      where: { spaceId: { in: spaceIds } },
      select: { spaceId: true },
      distinct: ["spaceId"],
    }),
    deps.prisma.chatGroup.findMany({
      where: { spaceId: { in: spaceIds } },
      select: { spaceId: true },
      distinct: ["spaceId"],
    }),
  ]);
  const spacesWithContent = new Set([
    ...contentBots.map((row) => row.spaceId),
    ...contentGroups.map((row) => row.spaceId),
  ]);
  const currentMembership = memberships.find((membership) => membership.spaceId === actor.spaceId);
  if (!currentMembership) throw new IsolationError();
  const botsBySpace = partitionBySpace([...currentBots, ...inactiveBots]);
  const groupsBySpace = partitionBySpace([...currentGroups, ...inactiveGroups]);
  const sectionsBySpace = partitionBySpace(botSections);
  const botsFor = (spaceId: string) => botsBySpace.get(spaceId) ?? [];
  const groupsFor = (spaceId: string) => groupsBySpace.get(spaceId) ?? [];
  const sectionsFor = (spaceId: string) => sectionsBySpace.get(spaceId) ?? [];
  const staleClaimBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);

  return {
    current: {
      id: actor.spaceId,
      name: currentMembership.space.name,
      bots: currentBots,
      groups: currentGroups,
      externalConversations: externalConversations.filter(
        (conversation) => conversation.spaceId === actor.spaceId,
      ),
      botSections: sectionsFor(actor.spaceId),
    },
    spaces: memberships.map((membership) => {
      const spaceBots = botsFor(membership.spaceId);
      const spaceGroups = groupsFor(membership.spaceId);
      return {
        id: membership.spaceId,
        name: membership.space.name,
        isDefault: membership.space.isDefault,
        hasContent: spacesWithContent.has(membership.spaceId),
        canDelete:
          membership.role === "owner" &&
          !membership.space.isDefault &&
          memberships.length > 1 &&
          !spacesWithContent.has(membership.spaceId) &&
          (membership.space.deletingAt === null || membership.space.deletingAt < staleClaimBefore),
        bots: spaceBots.map((bot) => ({
          id: bot.id,
          parentBotId: bot.parentBotId,
          spaceId: bot.spaceId,
          name: bot.name,
          title: bot.title,
          color: bot.color,
          notifyOnFinish: bot.notifyOnFinish,
          pinned: bot.pinned,
          sectionId: bot.sectionId,
          unread: bot.unread,
          preview: bot.preview,
          status: bot.status,
          updatedAt: bot.updatedAt,
        })),
        groups: spaceGroups.map((group) => ({
          id: group.id,
          spaceId: group.spaceId,
          name: group.name,
          pinned: group.pinned,
          sectionId: group.sectionId,
          members: group.members,
          preview: group.preview,
          unread: group.unread,
          updatedAt: group.updatedAt,
        })),
        externalConversations: externalConversations.filter(
          (conversation) => conversation.spaceId === membership.spaceId,
        ),
        botSections: sectionsFor(membership.spaceId),
      };
    }),
  };
}

function partitionBySpace<T extends { spaceId: string }>(rows: T[]): Map<string, T[]> {
  const partitioned = new Map<string, T[]>();
  for (const row of rows) {
    const spaceRows = partitioned.get(row.spaceId) ?? [];
    spaceRows.push(row);
    partitioned.set(row.spaceId, spaceRows);
  }
  return partitioned;
}

async function loadAutoReviewSettings(deps: RouterDeps, actor: Actor) {
  const environmentAvailable = isAutoReviewCheckerConfigured({ env: process.env });
  const checker = environmentAvailable ? null : resolveAutoReviewChecker(process.env);
  const requiredUserProvider = checker?.provider === "scripted" ? null : checker?.provider;
  const [preference, credential] = await Promise.all([
    deps.prisma.actionAutoReviewPreference.findUnique({
      where: {
        spaceId_userId: {
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      },
      select: { enabled: true },
    }),
    requiredUserProvider
      ? deps.prisma.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: requiredUserProvider },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const enabled = preference?.enabled ?? deploymentAutoReviewDefault(process.env);
  const checkerAvailable = environmentAvailable || Boolean(credential);
  return {
    enabled,
    checkerAvailable,
    configurationWarning: autoReviewConfigurationWarning(process.env),
  };
}

async function meDto(deps: RouterDeps, actor: Actor): Promise<Me> {
  const [user, setup] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
    modelSetup(deps, actor),
  ]);
  return {
    userId: actor.userId,
    email: user.email,
    name: user.name,
    spaceId: actor.spaceId,
    isDeploymentOwner: actor.isDeploymentOwner,
    needsModel: setup.needsModel,
    defaultProvider:
      setup.credential?.provider ??
      setup.settings?.defaultModelProvider ??
      deps.env.defaultProvider,
    defaultModel: setup.credential
      ? setup.credential.defaultModel
      : (setup.settings?.defaultModelId ?? deps.env.defaultModel),
    computerHost: computerHostFor(setup.settings?.computerHost, deps.env.sandboxProvider),
    canChooseHostComputer: actor.isDeploymentOwner && deps.env.sandboxProvider === "docker",
    sandboxProvider: deps.env.sandboxProvider,
    avatarStyle: user.avatarStyle === "organic" ? "organic" : "robot",
  };
}

async function modelSetup(deps: RouterDeps, actor: Actor) {
  const [credential, settings] = await Promise.all([
    findDefaultModelCredential(deps.prisma, actor),
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const hasDeployment = Boolean(deps.env.deploymentModelKey);
  return {
    credential,
    settings,
    needsModel:
      deps.env.agentRuntime !== "scripted" &&
      (credential?.provider === "ollama"
        ? !credential.defaultModel
        : !credential && !hasDeployment),
  };
}

async function computerStatus(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  let bot = await repos.getBot(actor, botId);
  if (await expireStaleComputerControl(deps, bot.computer)) {
    bot = await repos.getBot(actor, botId);
  }
  const busyBotName = await resolveBusyBotName(deps.prisma, {
    computerId: bot.computer?.id,
    botId,
    botName: bot.name,
  });
  return toComputerStatus(botId, bot.computer, busyBotName);
}

async function runComputerReplace(
  deps: RouterDeps,
  context: { actor: Actor },
  botId: string,
  mode: "recover" | "reset" | "update",
  operationId: string,
): Promise<ComputerStatus> {
  const repos = createRepos(deps.prisma);
  const bot = await repos.getBot(context.actor, botId);
  if (!bot.computer) throw new IsolationError();
  if (mode === "update" && !computerSupportsUpdate(bot.computer.kind)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Computer update is not available on this device",
    });
  }
  const manualRunId = `${mode}:${randomUUID()}`;
  let lease: ComputerExecutionLease | null;
  try {
    await releaseMaintenanceControl(deps, context.actor, bot.computer.id);
    lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: bot.computer.id,
      runId: manualRunId,
      botId: bot.id,
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw error;
  }
  try {
    await replaceComputer(deps, bot.computer.id, mode, {
      ...computerContext(context.actor, bot.id, operationId),
      screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
    });
    scheduleComputerSleep(deps.jobs, bot.computer.id);
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    }
    throw engineRefusal(error);
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, context.actor, botId);
}

/** A missing engine or a refused host move already says what to do, so it reaches the user. */
function engineRefusal(error: unknown) {
  return error instanceof MissingComputerProviderError ||
    (error instanceof Error && error.message === HOST_MOVE_UNAVAILABLE_MESSAGE)
    ? new ORPCError("BAD_REQUEST", { message: error.message })
    : error;
}

async function expireStaleComputerControl(
  deps: RouterDeps,
  computer:
    | (NonNullable<Parameters<typeof hasActiveComputerControl>[0]> & {
        id: string;
        controlHolder?: string;
      })
    | null
    | undefined,
): Promise<boolean> {
  if (!computer || hasActiveComputerControl(computer)) return false;
  if (computer.controlHolder !== "user") return false;
  const leaseId = computer.controlLeaseId;
  // Keep a failed revoke's lease id so reconciliation can retry provider shutdown.
  if (leaseId) {
    await expireComputerControl(deps, computer.id, leaseId).catch(() => undefined);
    return true;
  }
  return clearInactiveUserComputerControl(deps.prisma, computer.id).catch(() => false);
}

/** When the user already holds control during waiting_takeover, bind controlRunId so
 * takeoverRequested becomes true and release can resume the waiting run. */
async function bindWaitingTakeoverToControl(
  deps: RouterDeps,
  input: {
    spaceId: string;
    threadId: string | null | undefined;
    botId: string;
    computerId: string;
    controlLeaseId: string;
    controlRunId: string | null;
  },
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    // Lock the execution lease so a reclaimed fence/run cannot be bound by a stale read.
    const locked = await tx.$queryRaw<Array<{ runId: string; fence: number }>>`
      SELECT "runId", fence FROM computer_execution_leases
      WHERE "computerId" = ${input.computerId} AND "botId" = ${input.botId}
      FOR UPDATE`;
    const executionLease = locked[0];
    if (!executionLease) return;

    const executionRun = await tx.run.findUnique({
      where: { id: executionLease.runId },
      select: { botId: true, status: true },
    });
    const waitingForTakeover =
      executionRun?.botId === input.botId && executionRun.status === "waiting_takeover";
    if (!waitingForTakeover) return;
    if (input.controlRunId === executionLease.runId) return;

    // Confirm the locked lease row still matches before writing controlRunId.
    const leaseStillCurrent = await tx.computerExecutionLease.count({
      where: {
        computerId: input.computerId,
        botId: input.botId,
        runId: executionLease.runId,
        fence: executionLease.fence,
      },
    });
    if (leaseStillCurrent !== 1) return;

    const bound = await tx.computer.updateMany({
      where: {
        id: input.computerId,
        controlLeaseId: input.controlLeaseId,
        controlBotId: input.botId,
      },
      data: { controlRunId: executionLease.runId },
    });
    if (bound.count !== 1 || !input.threadId) return;

    await deps.events.append({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.granted",
      payload: { leaseId: input.controlLeaseId, takeoverRequested: true },
    });
  });
}

async function computerScreenContext(
  prisma: PrismaClient,
  actor: Actor,
  computerId: string,
  botId: string,
  operationId: string,
): Promise<AdapterContext> {
  const context = computerContext(actor, botId, operationId);
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId, botId } },
    select: { runId: true, fence: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return context;
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
}

async function deploymentDto(prisma: PrismaClient, sandboxProvider: string) {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  return {
    ownerUserId: settings?.ownerUserId ?? null,
    signupsEnabled: settings?.signupsEnabled ?? true,
    signupAllowlist: settings?.signupAllowlist
      ? settings.signupAllowlist.split(",").filter(Boolean)
      : [],
    hasDeploymentModelCredential: Boolean(settings?.deploymentModelCredentialCipher),
    defaultProvider: settings?.defaultModelProvider ?? null,
    defaultModel: settings?.defaultModelId ?? null,
    computerHost: computerHostFor(settings?.computerHost, sandboxProvider),
    canChooseHostComputer: sandboxProvider === "docker",
    sandboxProvider,
  };
}

function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac" || stored === "docker") return stored;
  return null;
}

async function persistModelCredential(
  deps: RouterDeps,
  actor: Actor,
  input: {
    provider: string;
    plaintext: string;
    label?: string;
    modelId?: string;
    supportsImages?: boolean;
    signal?: AbortSignal;
  },
) {
  throwIfAborted(input.signal);
  const stored = await deps.secrets.put(input.plaintext, {
    operationId: "cred",
    traceId: "cred",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  throwIfAborted(input.signal);
  const cred = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        throwIfAborted(input.signal);
        const existing = await tx.userModelCredential.findFirst({
          where: { userId: actor.userId, provider: input.provider },
          orderBy: newestModelCredentialOrder,
        });
        throwIfAborted(input.signal);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: null,
            kind: "model",
            ciphertext: stored.ciphertext,
          },
        });
        throwIfAborted(input.signal);
        const credential = !existing
          ? await tx.userModelCredential.create({
              data: {
                userId: actor.userId,
                provider: input.provider,
                label: input.label ?? input.provider,
                secretId: secret.id,
                supportsImages: input.supportsImages ?? false,
              },
            })
          : await tx.userModelCredential.update({
              where: { id: existing.id },
              data: {
                label: input.label ?? input.provider,
                secretId: secret.id,
                ...(input.supportsImages !== undefined
                  ? { supportsImages: input.supportsImages }
                  : {}),
              },
            });
        throwIfAborted(input.signal);
        const requestedModel = usableModelId(input.modelId);
        let defaultModel =
          input.provider === "ollama"
            ? requestedModel
            : (requestedModel ??
              defaultCatalogModelId(input.provider) ??
              usableModelId(deps.env.defaultModel));
        let isDefault = true;
        if (input.provider === "ollama" && !requestedModel) {
          // A pull-ready connection must not replace a working space selection.
          const preference = await tx.spaceModelPreference.findFirst({
            where: { spaceId: actor.spaceId, userId: actor.userId, credentialId: credential.id },
          });
          defaultModel = preference?.modelId ?? null;
          isDefault = preference?.isDefault ?? false;
        } else {
          await selectSpaceModelPreference(tx, actor, credential.id, defaultModel);
        }
        throwIfAborted(input.signal);
        if (existing) {
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "model",
            credentialId: existing.id,
            secretId: existing.secretId,
          });
          throwIfAborted(input.signal);
        }
        return { ...credential, isDefault, defaultModel };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return modelCredentialDto(cred, input.plaintext);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
}

function nextRoutineDate(crons: string[], timezone: string): Date {
  let next: Date | null;
  try {
    next = nextCronDateAcrossStrict(crons, new Date(), timezone);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  }
  if (!next) throw new ORPCError("BAD_REQUEST", { message: "Enter a valid cron expression." });
  return next;
}

function mapRoutine(row: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    crons: row.crons,
    timezone: row.timezone,
    active: row.active,
    notify: row.notify,
    webhookEnabled: row.webhookEnabled,
    githubEnabled: row.githubEnabled,
    messageProvider: row.messageProvider,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function listRoutinesDto(deps: RouterDeps, actor: Actor, botId: string) {
  const rows = await deps.prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId },
  });
  return rows.map(mapRoutine);
}

function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}

function duplicateBotName(name: string) {
  return `${name.slice(0, 75)} copy`;
}

const ACTIVE_CHANNEL_MEMBERS = {
  where: { status: { in: ["invited", "approved"] } },
  select: { id: true },
};

type MessagingIdentityRecord = {
  id: string;
  botId: string;
};

/** Every linked chat app counts: channels and connections span identities. */
async function messagingIdentitiesFor(
  prisma: PrismaClient,
  userId: string,
): Promise<MessagingIdentityRecord[]> {
  return prisma.messagingIdentity.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, botId: true },
  });
}

async function messagingIdentityDto(
  prisma: PrismaClient,
  identity: { id: string; provider: string; address: string; botId: string },
) {
  const bot = await prisma.bot.findUnique({
    where: { id: identity.botId },
    select: { name: true },
  });
  return {
    id: identity.id,
    provider: identity.provider,
    address: identity.address,
    botId: identity.botId,
    botName: bot?.name ?? "Assistant",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function messagingChannelDto(membership: {
  id: string;
  channelId: string;
  // Never null here: every membership reaching this DTO was matched by one of
  // the caller's identity ids.
  identityId: string | null;
  status: string;
  channel: { provider: string; name: string | null; members: Array<{ id: string }> };
}) {
  return {
    id: membership.id,
    channelId: membership.channelId,
    identityId: membership.identityId!,
    provider: membership.channel.provider,
    name: membership.channel.name,
    status: membership.status as "invited" | "approved" | "declined" | "left",
    memberCount: membership.channel.members.length,
  };
}

async function messagingConnectionDto(
  prisma: PrismaClient,
  myBotIds: ReadonlySet<string>,
  connection: {
    id: string;
    requesterBotId: string;
    targetBotId: string;
    status: string;
  },
) {
  const incoming = myBotIds.has(connection.targetBotId);
  // The target's identity stays opaque until they approve (mirrors connect_agent).
  if (!incoming && connection.status !== "approved") {
    return {
      id: connection.id,
      peerBotName: "agent",
      peerOwnerLabel: "owner",
      status: connection.status as "pending" | "approved" | "declined" | "revoked",
      incoming,
    };
  }
  const peerBotId = incoming ? connection.requesterBotId : connection.targetBotId;
  const peerBot = await prisma.bot.findUnique({
    where: { id: peerBotId },
    select: { name: true },
  });
  const peerIdentity = await prisma.messagingIdentity.findUnique({
    where: { botId: peerBotId },
    select: { userId: true },
  });
  const peerOwner = peerIdentity
    ? await prisma.user.findUnique({
        where: { id: peerIdentity.userId },
        select: { name: true },
      })
    : null;
  return {
    id: connection.id,
    peerBotName: peerBot?.name ?? "agent",
    peerOwnerLabel: peerOwner?.name.trim().split(/\s+/)[0] || "owner",
    status: connection.status as "pending" | "approved" | "declined" | "revoked",
    incoming,
  };
}
