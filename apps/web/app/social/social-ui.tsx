'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatApiError, chatApi, newClientId, uploadMedia } from '@/lib/chat-client';
import { Audience, AUDIENCE_LABEL, Comment, Post, PostBase, Story, StoryGroup, timeAgo } from '@/lib/social-client';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

const urlCache = new Map<string, { url: string; until: number }>();

/** Media through a short-lived URL the API issues only to people allowed to see it. */
export function RemoteMedia({ id, kind, alt }: { id: string; kind: 'image' | 'video'; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const hit = urlCache.get(id);
    if (hit && hit.until > Date.now()) return setUrl(hit.url);
    chatApi<{ url: string; expiresIn: number }>('GET', `media/${id}`)
      .then((r) => {
        urlCache.set(id, { url: r.url, until: Date.now() + (r.expiresIn - 30) * 1000 });
        setUrl(r.url);
      })
      .catch(() => setUrl(null));
  }, [id]);
  if (!url) return <div className="media-placeholder muted small">Loading…</div>;
  return kind === 'image' ? <img className="post-media" src={url} alt={alt} data-testid="post-image" /> : <video className="post-media" src={url} controls preload="metadata" />;
}

export function PostComposer({ communityId, onPosted, placeholder = 'What’s on your mind?' }: { communityId?: string; onPosted: (p: Post) => void; placeholder?: string }) {
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>('public');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="card composer-card"
      data-testid="post-composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim() && !files.length) return;
        setBusy(true);
        setErr(null);
        try {
          const mediaIds = [];
          for (const f of files) mediaIds.push((await uploadMedia(f, { kind: f.type.startsWith('video/') ? 'video' : 'image', fileName: f.name })).id);
          const r = await chatApi<{ post: Post }>('POST', 'posts', { clientId: newClientId(), body, mediaIds, ...(communityId ? { communityId } : { audience }) });
          onPosted(r.post);
          setBody('');
          setFiles([]);
        } catch (x) {
          setErr(errorText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea name="postBody" placeholder={placeholder} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={3} aria-label="Post text" />
      <div className="composer-row">
        <button type="button" className="btn quiet small" onClick={() => fileRef.current?.click()} disabled={busy}>
          📷 Photo or video
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
          data-testid="post-file-input"
          onChange={(e) => {
            // Copy now: clearing the input below empties its FileList before the state updater runs.
            const picked = Array.from(e.target.files ?? []);
            setFiles((f) => [...f, ...picked].slice(0, 10));
            e.target.value = '';
          }}
        />
        {files.length > 0 && (
          <span className="small muted">
            {files.length} attached{' '}
            <button type="button" className="link-btn" onClick={() => setFiles([])}>
              clear
            </button>
          </span>
        )}
        <span className="spacer" />
        {!communityId && (
          <select name="audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)} aria-label="Who can see this">
            {Object.entries(AUDIENCE_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        <button className="btn small" type="submit" disabled={busy || (!body.trim() && !files.length)}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
    </form>
  );
}

function PostBody({ post }: { post: PostBase }) {
  return (
    <>
      {post.body && <p className="post-body">{post.body}</p>}
      {post.media.length > 0 && (
        <div className="post-media-grid">
          {post.media.map((m) => (
            <RemoteMedia key={m.id} id={m.id} kind={m.kind} alt={`Photo by ${post.author.displayName}`} />
          ))}
        </div>
      )}
    </>
  );
}

function Byline({ post }: { post: PostBase }) {
  return (
    <div className="post-byline small">
      {post.author.username ? <Link href={`/u/${post.author.username}`}>{post.author.displayName}</Link> : <strong>{post.author.displayName}</strong>}
      {post.community && (
        <>
          {' '}
          in <Link href={`/communities/${post.community.slug}`}>{post.community.name}</Link>
        </>
      )}
      <span className="muted">
        {' '}
        · {timeAgo(post.createdAt)}
        {post.editedAt && ' · edited'}
        {!post.community && ` · ${AUDIENCE_LABEL[post.audience]}`}
      </span>
    </div>
  );
}

const REPORT_REASONS = ['spam', 'harassment', 'hate', 'violence', 'sexual_content', 'child_safety', 'fraud', 'impersonation', 'other'];

export function PostCard({ post, me, moderator, onChange }: { post: Post; me: string; moderator?: boolean; onChange: (p: Post | null) => void }) {
  const [showComments, setShowComments] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = post.author.id === me;
  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <article className="card post" data-testid="post" data-body={post.body}>
      <Byline post={post} />
      {post.removed && (
        <p className="error small" data-testid="post-removed">
          Removed by the community’s moderators{post.removed.reason ? `: ${post.removed.reason}` : ''}. Only you can see it.
        </p>
      )}
      <PostBody post={post} />
      {post.shared && (
        <div className="shared-post" data-testid="shared-post">
          {'unavailable' in post.shared ? (
            <em className="muted small">This post isn’t available to you.</em>
          ) : (
            <>
              <Byline post={post.shared} />
              <PostBody post={post.shared} />
            </>
          )}
        </div>
      )}
      <div className="post-actions small">
        <button
          className={`link-btn ${post.liked ? 'liked' : ''}`}
          data-testid="like"
          aria-pressed={post.liked}
          onClick={() =>
            act(async () => {
              const r = await chatApi<{ liked: boolean; likeCount: number }>('PUT', `posts/${post.id}/like`, { liked: !post.liked });
              onChange({ ...post, ...r });
            })
          }
        >
          {post.liked ? '♥' : '♡'} <span data-testid="like-count">{post.likeCount}</span>
        </button>
        <button className="link-btn" data-testid="comments-toggle" onClick={() => setShowComments((v) => !v)}>
          💬 {post.commentCount}
        </button>
        {!post.community && (
          <button
            className="link-btn"
            data-testid="share"
            onClick={() =>
              act(async () => {
                const text = window.prompt('Add a comment to your share (optional)', '');
                if (text === null) return;
                await chatApi('POST', 'posts', { clientId: newClientId(), body: text, sharedPostId: post.id, audience: 'public' });
              })
            }
          >
            ↗ Share
          </button>
        )}
        <details className="actions">
          <summary aria-label="More">⋯</summary>
          <div className="actions-menu">
            {mine && (
              <button
                onClick={() =>
                  act(async () => {
                    const body = window.prompt('Edit post', post.body);
                    if (body === null || body === post.body) return;
                    onChange({ ...post, ...(await chatApi<Post>('PATCH', `posts/${post.id}`, { body })) });
                  })
                }
              >
                Edit
              </button>
            )}
            {mine && !post.community && (
              <select
                aria-label="Change audience"
                value={post.audience}
                onChange={(e) => act(async () => onChange(await chatApi<Post>('PATCH', `posts/${post.id}`, { audience: e.target.value })))}
              >
                {Object.entries(AUDIENCE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    Audience: {label}
                  </option>
                ))}
              </select>
            )}
            {mine && (
              <button
                data-testid="delete-post"
                onClick={() =>
                  window.confirm('Delete this post?') &&
                  act(async () => {
                    await chatApi('DELETE', `posts/${post.id}`);
                    onChange(null);
                  })
                }
              >
                Delete
              </button>
            )}
            {moderator && post.community && !mine && (
              <button
                data-testid="moderate-post"
                onClick={() =>
                  act(async () => {
                    const reason = window.prompt('Reason for removing this post', '');
                    if (reason === null) return;
                    await chatApi('POST', `posts/${post.id}/moderation`, { removed: true, reason });
                    onChange(null);
                  })
                }
              >
                Remove as moderator
              </button>
            )}
            {!mine && (
              <select
                aria-label="Report"
                defaultValue=""
                onChange={(e) => {
                  const reason = e.target.value;
                  e.target.value = '';
                  if (reason)
                    void act(async () => {
                      await chatApi('POST', 'reports', { subjectType: 'post', subjectId: post.id, reason });
                      window.alert('Thanks, we’ll review it.');
                    });
                }}
              >
                <option value="">Report…</option>
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace('_', ' ')}
                  </option>
                ))}
              </select>
            )}
          </div>
        </details>
      </div>
      {err && <p className="error small">{err}</p>}
      {showComments && <Comments post={post} me={me} moderator={moderator} onCount={(n) => onChange({ ...post, commentCount: n })} />}
    </article>
  );
}

function Comments({ post, me, moderator, onCount }: { post: Post; me: string; moderator?: boolean; onCount: (n: number) => void }) {
  const [list, setList] = useState<Comment[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    chatApi<{ comments: Comment[]; nextCursor: string | null }>('GET', `posts/${post.id}/comments`)
      .then((r) => {
        setList(r.comments);
        setNext(r.nextCursor);
      })
      .catch((e) => setErr(errorText(e)));
  }, [post.id]);
  if (!list) return <p className="muted small">{err ?? 'Loading comments…'}</p>;
  return (
    <div className="comments" data-testid="comments">
      {list.map((c) => (
        <div key={c.id} className="comment small" data-testid="comment">
          <strong>{c.author.displayName}</strong> {c.body} <span className="muted">· {timeAgo(c.createdAt)}</span>
          {(c.author.id === me || post.author.id === me || moderator) && (
            <button
              className="link-btn"
              aria-label="Delete comment"
              onClick={async () => {
                try {
                  await chatApi('DELETE', `comments/${c.id}`);
                  const rest = list.filter((x) => x.id !== c.id);
                  setList(rest);
                  onCount(post.commentCount - 1);
                } catch (e) {
                  setErr(errorText(e));
                }
              }}
            >
              {' '}
              ✕
            </button>
          )}
        </div>
      ))}
      {next && (
        <button
          className="link-btn small"
          onClick={async () => {
            const r = await chatApi<{ comments: Comment[]; nextCursor: string | null }>('GET', `posts/${post.id}/comments?cursor=${next}`);
            setList([...list, ...r.comments]);
            setNext(r.nextCursor);
          }}
        >
          More comments
        </button>
      )}
      <form
        className="composer-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          try {
            const c = await chatApi<Comment>('POST', `posts/${post.id}/comments`, { body: text });
            setList([...list, c]);
            setText('');
            onCount(post.commentCount + 1);
          } catch (x) {
            setErr(errorText(x));
          }
        }}
      >
        <input name="comment" placeholder="Write a comment" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Comment" />
        <button className="btn small" type="submit">
          Comment
        </button>
      </form>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

/** A paged list of posts from one source: the home feed, a person, or a community. */
export function PostList({ source, me, moderator, prepend, empty }: { source: string; me: string; moderator?: boolean; prepend?: Post[]; empty: string }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    async (cursor?: string) => {
      try {
        const r = await chatApi<{ posts: Post[]; nextCursor: string | null }>('GET', `${source}${cursor ? `?cursor=${cursor}` : ''}`);
        setPosts((p) => (cursor ? [...(p ?? []), ...r.posts] : r.posts));
        setNext(r.nextCursor);
      } catch (e) {
        setErr(e instanceof ChatApiError && e.status === 404 ? 'Not available.' : errorText(e));
      }
    },
    [source],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Posts just written on this screen go on top.
  useEffect(() => {
    if (prepend?.length) setPosts((list) => [...prepend.filter((n) => !list?.some((x) => x.id === n.id)), ...(list ?? [])]);
  }, [prepend]);
  if (!posts) return <p className="muted">{err ?? 'Loading…'}</p>;
  return (
    <div className="post-list" data-testid="post-list">
      {posts.length === 0 && <p className="muted">{empty}</p>}
      {posts.map((p) => (
        <PostCard
          key={p.id}
          post={p}
          me={me}
          moderator={moderator}
          onChange={(np) => setPosts((list) => (np ? (list ?? []).map((x) => (x.id === p.id ? np : x)) : (list ?? []).filter((x) => x.id !== p.id)))}
        />
      ))}
      {next && (
        <button className="btn quiet" onClick={() => load(next)}>
          Show older posts
        </button>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

const STORY_COLOURS = ['#3D5AFE', '#00897B', '#C2185B', '#F57C00', '#5E35B1', '#263238'];

/** Stories from you and the people you follow. Opening one marks it seen. */
export function StoryTray({ me }: { me: string }) {
  const [groups, setGroups] = useState<StoryGroup[] | null>(null);
  const [open, setOpen] = useState<{ group: number; index: number } | null>(null);
  const [composing, setComposing] = useState(false);
  const refresh = useCallback(() => {
    chatApi<{ groups: StoryGroup[] }>('GET', 'stories')
      .then((r) => setGroups(r.groups))
      .catch(() => setGroups([]));
  }, []);
  useEffect(refresh, [refresh]);
  const current = open && groups ? groups[open.group]?.stories[open.index] : null;
  useEffect(() => {
    if (current && !current.viewed && current.author.id !== me) void chatApi('POST', `stories/${current.id}/views`).catch(() => undefined);
  }, [current, me]);
  return (
    <section className="story-tray" data-testid="story-tray">
      <button className="story-ring add" onClick={() => setComposing(true)} aria-label="Add to your story">
        +
      </button>
      {groups?.map((g, gi) => (
        <button key={g.author.id} className={`story-ring ${g.allViewed ? 'seen' : ''}`} data-testid="story-ring" onClick={() => setOpen({ group: gi, index: 0 })} title={g.author.displayName}>
          {g.author.id === me ? 'You' : g.author.displayName.slice(0, 2)}
        </button>
      ))}
      {composing && (
        <StoryComposer
          onDone={() => {
            setComposing(false);
            refresh();
          }}
        />
      )}
      {current && (
        <div className="story-viewer" role="dialog" aria-label={`Story by ${current.author.displayName}`} data-testid="story-viewer">
          <div className="story-frame" style={{ background: current.kind === 'text' ? current.background : '#000' }}>
            <div className="story-head small">
              <strong>{current.author.displayName}</strong> · {timeAgo(current.createdAt)}
              {current.viewCount !== null && <span data-testid="story-views"> · {current.viewCount} views</span>}
            </div>
            {current.media ? <RemoteMedia id={current.media.id} kind={current.media.kind} alt="Story" /> : null}
            {current.body && <p className="story-text">{current.body}</p>}
          </div>
          <div className="story-controls">
            <button
              className="btn quiet small"
              onClick={() => {
                const g = groups![open!.group];
                if (open!.index + 1 < g.stories.length) setOpen({ ...open!, index: open!.index + 1 });
                else if (open!.group + 1 < groups!.length) setOpen({ group: open!.group + 1, index: 0 });
                else {
                  setOpen(null);
                  refresh();
                }
              }}
            >
              Next
            </button>
            {current.author.id === me && (
              <button
                className="btn quiet small"
                onClick={async () => {
                  await chatApi('DELETE', `stories/${current.id}`);
                  setOpen(null);
                  refresh();
                }}
              >
                Delete
              </button>
            )}
            <button
              className="btn quiet small"
              onClick={() => {
                setOpen(null);
                refresh();
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function StoryComposer({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [bg, setBg] = useState(STORY_COLOURS[0]);
  const [audience, setAudience] = useState<'followers' | 'public'>('followers');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="story-viewer"
      data-testid="story-composer"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          if (file) {
            const kind = file.type.startsWith('video/') ? 'video' : 'image';
            const media = await uploadMedia(file, { kind, fileName: file.name });
            await chatApi<Story>('POST', 'stories', { kind, mediaId: media.id, body: text, audience });
          } else {
            await chatApi<Story>('POST', 'stories', { kind: 'text', body: text, background: bg, audience });
          }
          onDone();
        } catch (x) {
          setErr(errorText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="story-frame" style={{ background: file ? '#000' : bg }}>
        <textarea name="storyText" className="story-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder={file ? 'Add a caption' : 'Type your story'} aria-label="Story text" />
      </div>
      <div className="story-controls">
        {!file &&
          STORY_COLOURS.map((c) => (
            <button key={c} type="button" className={`swatch ${c === bg ? 'on' : ''}`} style={{ background: c }} aria-label={`Background ${c}`} onClick={() => setBg(c)} />
          ))}
        <label className="btn quiet small">
          {file ? file.name : 'Photo'}
          <input type="file" hidden accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <select value={audience} onChange={(e) => setAudience(e.target.value as 'followers' | 'public')} aria-label="Who can see this story">
          <option value="followers">Followers</option>
          <option value="public">Everyone</option>
        </select>
        <button className="btn small" type="submit" disabled={busy || (!file && !text.trim())}>
          Share story
        </button>
        <button type="button" className="btn quiet small" onClick={onDone}>
          Cancel
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
      <p className="muted small">Stories disappear after 24 hours.</p>
    </form>
  );
}
