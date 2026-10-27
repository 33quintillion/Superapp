import type { Pool } from 'pg';

export type GrantRole = 'admin' | 'moderator' | 'none';

/**
 * Grants or removes a platform staff role. Used by the admin:grant command, which is the
 * only way to make someone an admin: the first admin needs database access, not a form.
 */
export async function grantPlatformRole(pool: Pool, email: string, role: GrantRole) {
  const u = await pool.query<{ id: string; mfa_enabled_at: Date | null }>(`SELECT id, mfa_enabled_at FROM users WHERE email = $1 AND state = 'active'`, [email.toLowerCase()]);
  if (!u.rows[0]) throw new Error(`No active account with email ${email}`);
  const userId = u.rows[0].id;
  if (role === 'none') await pool.query('DELETE FROM platform_staff WHERE user_id = $1', [userId]);
  else {
    await pool.query(`INSERT INTO platform_staff (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`, [userId, role]);
  }
  await pool.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata) VALUES (NULL, 'admin.staff.cli', 'user', $1, $2)`, [
    userId,
    JSON.stringify({ role }),
  ]);
  return { userId, twoStepOn: !!u.rows[0].mfa_enabled_at };
}
