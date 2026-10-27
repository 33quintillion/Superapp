# Admin dashboard

The dashboard at `/admin` on the web is for platform staff. Endpoints are in [`api.md`](api.md#admin).

## Who can get in
Every request checks, in the API:

1. The account has a platform role: `moderator` or `admin`.
2. Two-step verification is on.
3. The current session was opened with a two-step code, within the last `ADMIN_SESSION_MAX_HOURS` (default 12). Refreshing the session keeps the mark but not past that age. Turning two-step on while signed in is not enough: sign out and back in.

The first admin can only be made from the command line, by someone with database access:

```bash
DATABASE_URL=... pnpm --filter @nexa/api admin:grant ada@example.com admin
DATABASE_URL=... pnpm --filter @nexa/api admin:grant ben@example.com moderator
DATABASE_URL=... pnpm --filter @nexa/api admin:grant ben@example.com none   # remove
```

Admins can then add and remove moderators in the dashboard. Admins can't be added or removed there.

## What each role can do
| | Moderator | Admin |
| --- | --- | --- |
| Work the report queue: open, take, dismiss, remove posts, comments, stories, messages and communities | ✓ | ✓ |
| Suspend and restore accounts | ✓ | ✓ |
| Suspend a business or switch off an integration from a report | | ✓ |
| Verify, suspend and restore businesses | | ✓ |
| Add, publish, change and switch off integrations | | ✓ |
| Add and remove moderators | | ✓ |
| Read the audit log | | ✓ |
| See an account's email address | | ✓ |

## The report queue
- Child-safety reports come first, then the oldest.
- Opening a report shows what was reported as it is now. For a message, it shows that one message only, never the chat around it. Opening is recorded in the audit log.
- Resolving a report closes every other open report about the same thing.
- "Remove" hides a post (its author still sees it, with your note as the reason), deletes a comment or story, removes a message for everyone in the chat, or closes a community. For a business or integration it suspends it.
- "Suspend" signs the account out everywhere, removes its push devices, hides its content and refuses sign-in with "This account has been suspended". Staff accounts can't be suspended here (remove their role first), and nobody can suspend themselves.

## Not built yet
- Viewing reported photos and files. The dashboard shows how many a post has; it waits for media scanning to be in place.
- Appeals, notices to the reported person, and reporter feedback.
- Escalation and legal-report workflows (NCMEC, IWF) for child-safety reports (**trust & safety and legal**).
- Queue assignment rules, SLAs and metrics.
