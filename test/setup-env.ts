import { config } from 'dotenv';
import { resolve } from 'path';

// e2e runs against the local Supabase stack configured in .env, with test-friendly overrides.
config({ path: resolve(__dirname, '../.env'), quiet: true });
process.env.NODE_ENV = 'test';
process.env.ENABLE_CRON = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.THROTTLE_WRITE_LIMIT = '100000';
process.env.LOG_LEVEL = 'error';
