const env = process.env;

export function loadConfig(overrides = {}) {
  const c = {
    port: Number(env.PORT || 3000),
    dbFile: env.DB_FILE || './data/bookclub.sqlite',
    botToken: env.BOT_TOKEN || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    adminIds: (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number),
    initDataMaxAgeSec: Number(env.INITDATA_MAX_AGE || 24 * 3600),
    // Вход без Telegram (только для разработки/тестов). В production игнорируется.
    devAuth: env.DEV_AUTH === '1' && env.NODE_ENV !== 'production',
    ...overrides,
  };
  return c;
}
