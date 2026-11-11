import { z } from 'zod';

export const MAX_PAGES = 10;
export const MAX_BLOCKS = 40;

const pageId = z.string().regex(/^[a-z0-9-]{1,20}$/, 'Page ids are 1-20 lowercase letters, digits or dashes');
const httpsUrl = z
  .url()
  .max(500)
  .refine((u) => u.startsWith('https://'), 'Links must start with https://');

/** What a button does. Orders, bookings and calls use the business's own settings. */
export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), pageId }).strict(),
  z.object({ type: z.literal('order') }).strict(),
  z.object({ type: z.literal('book') }).strict(),
  z.object({ type: z.literal('call') }).strict(),
  z.object({ type: z.literal('link'), url: httpsUrl }).strict(),
]);

export const Block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().trim().min(1).max(120) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('button'), label: z.string().trim().min(1).max(40), action: Action }).strict(),
  /** The business's catalogue, live, with prices. */
  z.object({ type: z.literal('items'), title: z.string().trim().max(60).default('') }).strict(),
  /** The business's opening hours, live. */
  z.object({ type: z.literal('hours') }).strict(),
  z.object({ type: z.literal('location'), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().trim().max(120).default('') }).strict(),
  z.object({ type: z.literal('divider') }).strict(),
]);
export type BlockT = z.infer<typeof Block>;

export const Page = z.object({ id: pageId, title: z.string().trim().min(1).max(40), blocks: z.array(Block).max(MAX_BLOCKS) }).strict();

export const ACCENTS = ['navy', 'burgundy', 'gold', 'red', 'green'] as const;

export const MiniProgramBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    tagline: z.string().trim().max(120).default(''),
    /** One emoji shown as the icon. */
    icon: z
      .string()
      .max(16)
      .regex(/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️⃣])+$/u, 'Use one emoji')
      .default('🛍️'),
    accent: z.enum(ACCENTS).default('navy'),
    pages: z.array(Page).min(1).max(MAX_PAGES),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    p.pages.forEach((page, i) => {
      if (ids.has(page.id)) ctx.addIssue({ code: 'custom', path: ['pages', i, 'id'], message: 'Each page needs its own id' });
      ids.add(page.id);
    });
    p.pages.forEach((page, i) =>
      page.blocks.forEach((b, j) => {
        if (b.type === 'button' && b.action.type === 'page' && !ids.has(b.action.pageId)) {
          ctx.addIssue({ code: 'custom', path: ['pages', i, 'blocks', j, 'action', 'pageId'], message: 'That button goes to a page that doesn’t exist' });
        }
      }),
    );
  });
export type MiniProgramT = z.infer<typeof MiniProgramBody>;

export const MiniListQuery = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(30) });
