import { ApiError } from '@/lib/api';
import { authed } from '@/lib/session';
import { openChatWith } from '../../actions';

export const dynamic = 'force-dynamic';

interface Person {
  id: string;
  username: string | null;
  displayName: string;
  self: boolean;
}

/** Someone's SuperApp code, typed in or opened from a link: who it is, and a button to chat. */
export default async function AddPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let person: Person | null = null;
  try {
    person = await authed<Person>('GET', `/v1/contact-codes/${encodeURIComponent(code)}`);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
  }
  return (
    <main>
      <h1>Add a contact</h1>
      {!person ? (
        <p data-testid="code-unknown">This code doesn’t work. It may have been typed wrong or reset by its owner.</p>
      ) : person.self ? (
        <p>That’s your own code.</p>
      ) : (
        <div className="card stack" data-testid="code-person">
          <div>
            <strong>{person.displayName}</strong>
            {person.username && <span className="muted"> @{person.username}</span>}
          </div>
          <form action={openChatWith}>
            <input type="hidden" name="userId" value={person.id} />
            <button className="btn" type="submit" data-testid="message-person">
              Message {person.displayName}
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
