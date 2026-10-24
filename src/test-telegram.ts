import 'dotenv/config';
import { loadEnv } from './config';
import { notify } from './notifier';

await notify(loadEnv(), '✅ <b>Price Tracker — Telegram test</b>\nYour Telegram connection is working.', { preview: false });
console.log('Telegram connection test completed.');
