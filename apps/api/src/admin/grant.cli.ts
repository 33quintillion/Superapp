import { Pool } from 'pg';
import { GrantRole, grantPlatformRole } from './grant';

/**
 *   pnpm --filter @nexa/api admin:grant ada@example.com admin
 *   pnpm --filter @nexa/api admin:grant ben@example.com moderator
 *   pnpm --filter @nexa/api admin:grant ben@example.com none
 */
async function main() {
  const [email, role] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!email || !['admin', 'moderator', 'none'].includes(role)) throw new Error('Usage: admin:grant <email> <admin|moderator|none>');
  const pool = new Pool({ connectionString: url });
  try {
    const out = await grantPlatformRole(pool, email, role as GrantRole);
    console.log(role === 'none' ? `${email} is no longer platform staff` : `${email} is now ${role}`);
    if (role !== 'none' && !out.twoStepOn) console.log('They must turn on two-step verification and sign in again before the dashboard opens.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
