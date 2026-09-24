import type { PrismaClient } from "@ardurbot/db";

/** Until host pairing exists, one OS login must not become every server user's subscription. */
export async function nativeHostOwner(prisma: PrismaClient, userId: string): Promise<boolean> {
  const users = await prisma.user.findMany({ select: { id: true }, take: 2 });
  return users.length === 1 && users[0]?.id === userId;
}
export const NATIVE_HOST_OWNER_MESSAGE =
  "Native runtimes need a single-user host for now — change the pin.";
