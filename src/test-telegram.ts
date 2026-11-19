import 'dotenv/config';
import { loadEnv } from './config';
import { notify } from './notifier';

// TELEGRAM_TEST_MESSAGE (Telegram HTML) replaces the default text, e.g. to confirm a change is live.
const message = process.env.TELEGRAM_TEST_MESSAGE?.trim() ||
  '✅ <b>Price Tracker — Telegram test</b>\nYour Telegram connection is working.';
await notify(loadEnv(), message, { preview: false });
console.log('Telegram connection test completed.');
