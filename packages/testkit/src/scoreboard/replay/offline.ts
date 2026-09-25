import { Socket } from "node:net";

/** CLI-only environment. Provider credentials stay out; a virtual display is not a credential. */
export function credentialFreeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
    "TESTCONTAINERS_HOST_OVERRIDE",
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]!]])),
  );
}

/** Install after images and dependencies are provisioned. Loopback is the local stack, not Internet. */
export function denyExternalTcp() {
  const original = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: Parameters<Socket["connect"]>) {
    const first: unknown = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    let host: unknown;
    if (options && typeof options === "object") {
      if ("path" in options && typeof options.path === "string")
        throw new Error("Offline replay disallows new Unix socket clients");
      host =
        "host" in options && typeof options.host === "string"
          ? options.host
          : "hostname" in options
            ? options.hostname
            : "localhost";
    } else if (typeof options === "number")
      host = typeof args[1] === "string" ? args[1] : "localhost";
    else throw new Error("Offline replay requires an explicit loopback TCP connection");
    if (!["127.0.0.1", "::1", "localhost"].includes(String(host)))
      throw new Error("External network disabled for replay");
    return Reflect.apply(original, this, args);
  } as Socket["connect"];
  return () => {
    Socket.prototype.connect = original;
  };
}
