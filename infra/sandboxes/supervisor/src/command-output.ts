import { StringDecoder } from "node:string_decoder";
import { COMMAND_OUTPUT_LIMIT, createBoundedCommandOutput } from "@ardurbot/core";

/** Incremental Docker multiplex framing; payloads and frames are never accumulated. */
export function createDockerCommandOutput(limit = COMMAND_OUTPUT_LIMIT) {
  const stdout = createBoundedCommandOutput(limit);
  const stderr = createBoundedCommandOutput(limit);
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  const header = Buffer.alloc(8);
  let headerSize = 0;
  let remaining = 0;
  let stream = 1;
  return {
    push(chunk: Buffer) {
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining === 0) {
          const count = Math.min(8 - headerSize, chunk.length - offset);
          chunk.copy(header, headerSize, offset, offset + count);
          headerSize += count;
          offset += count;
          if (headerSize < 8) continue;
          stream = header[0]!;
          if ((stream !== 1 && stream !== 2) || header[1] || header[2] || header[3])
            throw new Error("Invalid command output frame");
          remaining = header.readUInt32BE(4);
          headerSize = 0;
        }
        const count = Math.min(remaining, chunk.length - offset, 4096);
        const target = stream === 2 ? stderr : stdout;
        const decoder = stream === 2 ? errDecoder : outDecoder;
        if (!target.truncated) target.push(decoder.write(chunk.subarray(offset, offset + count)));
        offset += count;
        remaining -= count;
      }
    },
    finish() {
      if (remaining || headerSize) throw new Error("Incomplete command output frame");
      stdout.push(outDecoder.end());
      stderr.push(errDecoder.end());
      return { stdout: stdout.value(), stderr: stderr.value() };
    },
  };
}
