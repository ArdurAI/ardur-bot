import * as z from "zod";

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export const MessageReactionSchema = z.enum(MESSAGE_REACTIONS);
export type MessageReaction = z.infer<typeof MessageReactionSchema>;

export const FeedbackSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  messageId: z.string(),
  runId: z.string(),
  rating: z.enum(["positive", "negative"]),
  reason: z.string().max(500).nullable(),
  retractedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;
export const FeedbackReasonSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^[^\r\n]*$/);
