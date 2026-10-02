import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AcpClient } from "./acp-client.js";
import { stopNative } from "./native-process.js";

describe("AcpClient request correlation", () => {
  it("uses increasing IDs and times out a silent request", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'process.stdin.setEncoding("utf8");let buf="";process.stdin.on("data",chunk=>{buf+=chunk;let end;while((end=buf.indexOf("\\n"))>=0){const item=JSON.parse(buf.slice(0,end));buf=buf.slice(end+1);if(item.method==="silent")continue;process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:item.id,result:{seen:item.id}})+"\\n")}})',
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" },
    );
    child.stderr.resume();
    const client = new AcpClient(child);
    try {
      expect(await client.request("first", {})).toEqual({ seen: 1 });
      await expect(client.request("silent", {}, 30)).rejects.toMatchObject({
        message: "ACP request timed out.",
        kind: "timeout",
      });
      expect(await client.request("third", {})).toEqual({ seen: 3 });
    } finally {
      client.close();
      await stopNative(child);
    }
  });
  it("fails a write after stdin closes without an unhandled stream error", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'process.stdin.once("data",chunk=>{const item=JSON.parse(chunk.toString());process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:item.id,result:{ok:true}})+"\\n");setTimeout(()=>{},1000)})',
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" },
    );
    child.stderr.resume();
    const client = new AcpClient(child);
    try {
      expect(await client.request("first", {})).toEqual({ ok: true });
      child.stdin.destroy();
      await expect(client.request("second", {}, 500)).rejects.toMatchObject({
        message: "ACP input closed.",
        kind: "closed",
      });
    } finally {
      client.close();
      await stopNative(child);
    }
  });
});
