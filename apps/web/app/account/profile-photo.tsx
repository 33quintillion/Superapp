'use client';

import { useRef, useState } from 'react';
import { chatApi, uploadMedia } from '@/lib/chat-client';
import { Avatar } from '../social/social-ui';

const TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/heic';

/** Choose, change or remove the profile photo. It uploads like a chat photo, then becomes the photo. */
export function ProfilePhoto({ initial, name }: { initial: string | null; name: string }) {
  const [mediaId, setMediaId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function run(work: () => Promise<{ avatarMediaId: string | null }>) {
    setBusy(true);
    setError(null);
    try {
      setMediaId((await work()).avatarMediaId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="card photo-editor" data-testid="profile-photo">
      <Avatar mediaId={mediaId} name={name} size={72} />
      <label className="btn quiet small">
        {mediaId ? 'Change photo' : 'Add a photo'}
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept={TYPES}
          data-testid="avatar-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run(async () => {
              const m = await uploadMedia(file, { kind: 'image', fileName: file.name });
              return chatApi('PUT', 'me/avatar', { mediaId: m.id });
            });
          }}
        />
      </label>
      {mediaId && (
        <button className="btn quiet small" type="button" disabled={busy} data-testid="avatar-remove" onClick={() => run(() => chatApi('DELETE', 'me/avatar'))}>
          Remove photo
        </button>
      )}
      {busy && <span className="muted small">Uploading…</span>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
