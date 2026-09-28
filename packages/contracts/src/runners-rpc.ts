import { oc } from "@orpc/contract";
import { z } from "zod";

export const runnersContract = oc.router({
  list: oc.input(z.void()).output(z.object({ runners: z.array(z.any()) })),
  // more procedures...
});
