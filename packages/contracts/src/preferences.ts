import * as z from "zod";

export const NotificationPreferencesSchema = z.object({
  responseCompletions: z.boolean().default(true),
  routines: z.boolean().default(true),
  approvalsNeeded: z.boolean().default(true),
  dispatchMessages: z.boolean().default(true),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type NotificationCategory = keyof NotificationPreferences;
export const NotificationActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  threadId: z.string(),
  category: NotificationPreferencesSchema.keyof(),
  status: z.enum(["completed", "failed", "waiting_input", "waiting_takeover", "board_changed"]),
  board: z
    .object({
      spaceId: z.string(),
      workspaceId: z.string(),
      itemId: z.string(),
      // The notice for a board close that kept failing; screens word it in the reader's language.
      closeFailed: z.boolean().optional(),
      // That close failed because the bot that filed the item can no longer use the board.
      closeDenied: z.boolean().optional(),
    })
    .optional(),
  updatedAt: z.string(),
  occurredAt: z.string().optional(),
  enabled: z.boolean(),
});
export type NotificationActivity = z.infer<typeof NotificationActivitySchema>;

export const UserPreferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  chatFont: z.enum(["sans", "serif", "system"]).default("sans"),
  motion: z.enum(["system", "reduced"]).default("system"),
  notifications: NotificationPreferencesSchema.default(() =>
    NotificationPreferencesSchema.parse({}),
  ),
  preferredBrowser: z.enum(["builtin"]).default("builtin"),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;
export const DEFAULT_USER_PREFERENCES: UserPreferences = UserPreferencesSchema.parse({});

export const PreferencesPatchSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  chatFont: z.enum(["sans", "serif", "system"]).optional(),
  motion: z.enum(["system", "reduced"]).optional(),
  preferredBrowser: z.enum(["builtin"]).optional(),
  notifications: z
    .object({
      responseCompletions: z.boolean().optional(),
      routines: z.boolean().optional(),
      approvalsNeeded: z.boolean().optional(),
      dispatchMessages: z.boolean().optional(),
    })
    .optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;
