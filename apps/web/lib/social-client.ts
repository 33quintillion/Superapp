// Types for the social screens. Calls go through the same proxy as chat (chatApi).

export interface UserSummary {
  id: string;
  username: string | null;
  displayName: string;
}

export interface PostMedia {
  id: string;
  kind: 'image' | 'video';
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

export type Audience = 'public' | 'followers' | 'only_me';

export interface PostBase {
  id: string;
  author: UserSummary;
  community: { id: string; slug: string; name: string; kind: 'community' | 'channel' } | null;
  audience: Audience;
  body: string;
  media: PostMedia[];
  likeCount: number;
  commentCount: number;
  liked: boolean;
  createdAt: string;
  editedAt: string | null;
  removed: { at: string; reason: string | null } | null;
}

export interface Post extends PostBase {
  shared: PostBase | { id: string; unavailable: true } | null;
}

export interface Comment {
  id: string;
  postId: string;
  author: UserSummary;
  body: string;
  createdAt: string;
}

export interface Story {
  id: string;
  author: UserSummary;
  kind: 'text' | 'image' | 'video';
  body: string;
  background: string;
  audience: 'public' | 'followers';
  media: PostMedia | null;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
  viewCount: number | null;
}

export interface StoryGroup {
  author: UserSummary;
  stories: Story[];
  allViewed: boolean;
}

export interface Profile {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  statusText: string;
  privateAccount: boolean;
  followerCount: number;
  followingCount: number;
  relationship: { following: 'none' | 'pending' | 'active'; followsYou: boolean } | null;
}

export type CommunityRole = 'owner' | 'admin' | 'moderator' | 'member';

export interface Community {
  id: string;
  slug: string;
  kind: 'community' | 'channel';
  name: string;
  description: string;
  visibility: 'public' | 'private';
  memberCount: number;
  membership: { role: CommunityRole; state: 'active' | 'pending' } | null;
  createdAt: string;
}

export const AUDIENCE_LABEL: Record<Audience, string> = { public: 'Everyone', followers: 'Followers', only_me: 'Only me' };

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}
