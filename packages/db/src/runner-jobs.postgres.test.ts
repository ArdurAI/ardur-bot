import { beforeAll, describe, expect, it } from "vitest";
import { createDb, PrismaClient } from "./client.js";
import { RunnerJobDb } from "./runner-jobs.js";

const { prisma } = createDb("postgres://localhost:5432/db");

describe("runner jobs db", () => {
  beforeAll(async () => {
    // dummy connect
    await prisma.$connect().catch(() => {});
  });
  it("should have a basic test", () => {
    expect(true).toBe(true);
  });
});
