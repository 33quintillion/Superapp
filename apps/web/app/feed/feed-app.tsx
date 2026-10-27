'use client';

import { useState } from 'react';
import type { Post } from '@/lib/social-client';
import { PostComposer, PostList, StoryTray } from '../social/social-ui';

export function FeedApp({ me }: { me: string }) {
  const [mine, setMine] = useState<Post[]>([]);
  return (
    <main className="wide social">
      <StoryTray me={me} />
      <PostComposer onPosted={(p) => setMine((m) => [p, ...m])} />
      <PostList source="feed" me={me} prepend={mine} empty="Nothing here yet. Follow people or join a community to fill your feed." />
    </main>
  );
}
