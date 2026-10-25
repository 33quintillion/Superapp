import { loadConfig } from './config/config';
import { createApp } from './app';

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
