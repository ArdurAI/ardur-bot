export function installSmokeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ARDUR_INSTALL_SMOKE === "1";
}

/** Starts before loading the main module, including its transitive imports. */
export function startInstallSmokeWatchdog(deps: {
  report: (message: string) => void;
  exit: (code: number) => void;
}) {
  let currentStage = "main module loading";
  deps.report(`smoke: ${currentStage}`);
  const watchdog = setTimeout(() => {
    deps.report(`smoke: timed out at ${currentStage}`);
    deps.exit(1);
  }, 150_000);
  watchdog.unref();
  return {
    stage(value: string) {
      currentStage = value;
      deps.report(`smoke: ${currentStage}`);
    },
    fail(error: unknown) {
      deps.report(`smoke: failed at ${currentStage}: ${String(error)}`);
      deps.exit(1);
    },
    dispose() {
      clearTimeout(watchdog);
    },
  };
}

/** The release probe never accepts a window alone or a successful second-instance exit. */
export async function runInstallSmoke(deps: {
  start: () => Promise<{ phase: string }>;
  healthy: () => Promise<boolean>;
  open: () => Promise<boolean>;
  screenshot: () => Promise<void>;
  stop: () => Promise<void>;
  report: (message: string) => void;
  stage: (message: string) => void;
}): Promise<void> {
  try {
    deps.stage("services starting");
    if ((await deps.start()).phase !== "ready" || !(await deps.healthy())) {
      throw new Error("Local services did not become healthy.");
    }
    deps.stage("health ok");
    deps.stage("window loading");
    if (!(await deps.open())) throw new Error("The main window did not load.");
    deps.stage("window loaded");
    deps.stage("screenshot capturing");
    await deps.screenshot();
    deps.stage("services stopping");
    await deps.stop();
    deps.stage("services stopped");
    deps.report("ARDUR_INSTALL_SMOKE_PASS");
  } catch (error) {
    deps.stage("failure cleanup");
    await deps.stop();
    throw error;
  }
}
