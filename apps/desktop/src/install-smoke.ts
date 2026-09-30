export function installSmokeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ARDUR_INSTALL_SMOKE === "1";
}

/** The release probe never accepts a window alone or a successful second-instance exit. */
export async function runInstallSmoke(deps: {
  start: () => Promise<{ phase: string }>;
  healthy: () => Promise<boolean>;
  open: () => Promise<boolean>;
  screenshot: () => Promise<void>;
  stop: () => Promise<void>;
  report: (message: string) => void;
}): Promise<void> {
  try {
    if ((await deps.start()).phase !== "ready" || !(await deps.healthy())) {
      throw new Error("Local services did not become healthy.");
    }
    if (!(await deps.open())) throw new Error("The main window did not load.");
    await deps.screenshot();
    await deps.stop();
    deps.report("ARDUR_INSTALL_SMOKE_PASS");
  } catch (error) {
    await deps.stop();
    throw error;
  }
}
