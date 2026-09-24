import type { AdapterContext } from "@ardurbot/adapter-kit";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** HTTP boundary double for the same provider contract on a Podman-selected supervisor. */
export function fakePodmanSupervisor(context: AdapterContext) {
  const provider = new FakeSandboxProvider();
  return async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (
      headers.get("x-ardurbot-engine") !== "podman" ||
      headers.get("x-ardurbot-engine-socket") !== "/tmp/podman.sock"
    )
      return Response.json({}, { status: 400 });
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === "/computers" && method === "POST") {
      const computer = await provider.provision(body, context);
      return Response.json({ id: computer.id, resumed: !computer.fresh });
    }
    const id = url.pathname.split("/")[2]!;
    const computer = provider.boxes.get(id)?.ref;
    if (!computer) return Response.json({}, { status: 404 });
    if (url.pathname.endsWith("/files")) {
      const filePath = url.searchParams.get("path") ?? "";
      if (method === "POST") {
        await provider.writeFile(
          computer,
          {
            path: body.path,
            content: Buffer.from(body.content, "base64"),
            executable: body.executable,
          },
          context,
        );
        return Response.json({ ok: true });
      }
      if (url.searchParams.get("mode") === "list")
        return Response.json(await provider.listFiles(computer, filePath, context));
      return Response.json({
        content: Buffer.from(await provider.readFile(computer, filePath, context)).toString(
          "base64",
        ),
      });
    }
    if (url.pathname.endsWith("/exec")) {
      let stdout = "";
      let stderr = "";
      let code = 1;
      for await (const event of provider.execute(computer, body, context)) {
        if (event.type === "stdout") stdout += event.data;
        else if (event.type === "stderr") stderr += event.data;
        else code = event.code;
      }
      return Response.json({ stdout, stderr, code });
    }
    if (url.pathname.endsWith("/stop")) {
      await provider.stop(computer, context);
      return Response.json({ ok: true });
    }
    if (method === "DELETE") {
      await provider.destroy(computer, context);
      return Response.json({ ok: true });
    }
    return Response.json({ running: provider.boxes.get(id)?.running });
  };
}
