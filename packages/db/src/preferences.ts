import type { PreferencesPatch } from "@ardurbot/contracts";
import { UserPreferencesSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "./client.js";

type PreferencesDatabase = Pick<PrismaClient, "userPreferences">;

function preferencesDto(row: Record<string, unknown> | null) {
  return UserPreferencesSchema.parse(row ? { ...row, notifications: row } : {});
}

export async function getUserPreferences(prisma: PreferencesDatabase, userId: string) {
  return preferencesDto(await prisma.userPreferences.findUnique({ where: { userId } }));
}

/** Separate columns make simultaneous updates to different notification switches atomic. */
export async function updateUserPreferences(
  prisma: PreferencesDatabase,
  userId: string,
  patch: PreferencesPatch,
) {
  const { notifications, ...settings } = patch;
  const data = { ...settings, ...notifications };
  return preferencesDto(
    await prisma.userPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    }),
  );
}
