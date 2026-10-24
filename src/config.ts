import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { siteFor } from './sources';
import { isAsicsProductUrl } from './parsers/asics';
import type { TrackerConfig } from './types';

const trackerSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    url: z.string().url(),
    mode: z.enum(['listings', 'discount']).optional(),
    referencePrice: z.number().positive().optional(),
    filters: z
      .object({
        priceMin: z.number().positive().optional(),
        priceMax: z.number().positive().optional(),
        titleMustInclude: z.array(z.string()).optional(),
        minBatteryHealth: z.number().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    phoneTaxEgp: z.number().nonnegative().optional(),
    details: z.array(z.string()).optional(),
    compareBy: z.array(z.string()).optional(),
  })
  // Reject unknown keys: a typo ("minBateryHealth") fails loudly instead of silently not filtering.
  .strict()
  .superRefine((tracker, ctx) => {
    if (tracker.mode === 'discount') {
      if (!isAsicsProductUrl(tracker.url)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'discount tracking requires an ASICS France product URL with size and width' });
      }
      if (tracker.referencePrice === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referencePrice'], message: 'discount tracking requires a starting referencePrice in EUR' });
      }
      if (tracker.filters || tracker.phoneTaxEgp !== undefined || tracker.compareBy || tracker.details) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'listing filters and market options do not apply to discount trackers' });
      }
    } else {
      try { siteFor(tracker.url); }
      catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: `unsupported site: ${tracker.url}` }); }
      if (tracker.referencePrice !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referencePrice'], message: 'referencePrice requires discount mode' });
      }
    }
  });

const trackersSchema = z
  .array(trackerSchema)
  .min(1)
  .refine((trackers) => new Set(trackers.map((tracker) => tracker.id)).size === trackers.length, {
    message: 'tracker ids must be unique — the id is the key the seen-state is stored under',
  });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadTrackers(path = resolve(repoRoot, 'config/trackers.json')): TrackerConfig[] {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return trackersSchema.parse(parsed);
}

export interface AppEnv {
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly dryRun: boolean;
}

export function loadEnv(): AppEnv {
  const dryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const telegramChatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (!dryRun && (!telegramBotToken || !telegramChatId)) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (or run with DRY_RUN=1 to preview without sending).',
    );
  }

  return { telegramBotToken, telegramChatId, dryRun };
}
