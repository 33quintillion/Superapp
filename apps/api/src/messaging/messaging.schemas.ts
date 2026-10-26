import { z } from 'zod';
import { MAX_BODY } from './messaging.service';

export const clientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'clientId must be 8-64 letters, digits, - or _');

export const SendBody = z
  .object({
    clientId: clientIdSchema,
    kind: z.enum(['text', 'image', 'video', 'audio', 'voice', 'file']).default('text'),
    body: z.string().max(MAX_BODY).default(''),
    mediaId: z.uuid().optional(),
    replyToId: z.uuid().optional(),
    mentions: z
      .array(z.uuid())
      .max(50)
      .default([])
      .transform((m) => [...new Set(m)]),
  })
  .strict();

export const EditBody = z.object({ body: z.string().max(MAX_BODY) }).strict();

/** One emoji (including skin tones, flags and ZWJ sequences), or null to remove. */
export const ReactBody = z
  .object({
    emoji: z
      .string()
      .max(16)
      .regex(/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️⃣])+$/u, 'Use a single emoji')
      .nullable(),
  })
  .strict();

export const PinBody = z.object({ pinned: z.boolean() }).strict();

export const ForwardBody = z
  .object({ conversationIds: z.array(z.uuid()).min(1).max(5), clientId: clientIdSchema })
  .strict();

export const ReceiptBody = z.object({ kind: z.enum(['delivered', 'read']), seq: z.number().int().nonnegative() }).strict();

export const MembershipPatch = z
  .object({ mutedUntil: z.iso.datetime({ offset: true }).nullable().transform((v) => (v ? new Date(v) : null)), archived: z.boolean() })
  .partial()
  .strict();

const intParam = (max: number) => z.coerce.number().int().nonnegative().max(max);

export const MessagesQuery = z
  .object({
    before: intParam(Number.MAX_SAFE_INTEGER).optional(),
    after: intParam(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => q.before === undefined || q.after === undefined, 'Use before or after, not both');

export const ChangesQuery = z.object({
  since: intParam(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const ConversationsQuery = z.object({
  archived: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  conversationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

export const PresenceQuery = z.object({
  userIds: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(100)),
});
