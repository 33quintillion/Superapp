import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { clientIdSchema } from '../messaging/messaging.schemas';
import { CommunitiesService } from './communities.service';
import { FollowsService } from './follows.service';
import { MAX_POST_MEDIA, PostsService } from './posts.service';
import { StoriesService } from './stories.service';

const id = (v: string) => parse(z.uuid(), v);

const Page = (max: number, dflt: number) =>
  z.object({ limit: z.coerce.number().int().min(1).max(max).default(dflt), cursor: z.string().max(200).optional() });

const audience = z.enum(['public', 'followers', 'only_me']);

const CreatePost = z
  .object({
    clientId: clientIdSchema,
    body: z.string().max(5000).default(''),
    audience: audience.default('public'),
    mediaIds: z
      .array(z.uuid())
      .max(MAX_POST_MEDIA)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length, 'Each file can only be attached once'),
    sharedPostId: z.uuid().optional(),
    communityId: z.uuid().optional(),
  })
  .strict();

const PostPatch = z.object({ body: z.string().max(5000), audience }).partial().strict();
const LikeBody = z.object({ liked: z.boolean() }).strict();
const CommentBody = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
const ModerationBody = z.object({ removed: z.boolean(), reason: z.string().trim().max(500).default('') }).strict();

const CreateStory = z
  .object({
    kind: z.enum(['text', 'image', 'video']),
    body: z.string().max(500).default(''),
    background: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #3D5AFE')
      .default('#3D5AFE'),
    mediaId: z.uuid().optional(),
    audience: z.enum(['public', 'followers']).default('followers'),
  })
  .strict();

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,39}$/, 'Use 3-40 letters, numbers, - or _');
const CreateCommunity = z
  .object({
    slug,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(''),
    kind: z.enum(['community', 'channel']).default('community'),
    visibility: z.enum(['public', 'private']).default('public'),
  })
  .strict();
const CommunityPatch = z
  .object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(1000), visibility: z.enum(['public', 'private']) })
  .partial()
  .strict();
const MemberPatch = z
  .object({ role: z.enum(['owner', 'admin', 'moderator', 'member']), state: z.enum(['active', 'banned']) })
  .partial()
  .strict()
  .refine((v) => v.role || v.state, 'Give a role or a state');
const CommunityQuery = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const MembersQuery = z.object({ state: z.enum(['active', 'pending', 'banned']).default('active'), limit: z.coerce.number().int().min(1).max(200).default(100) });
const communityRef = (v: string) => parse(z.union([z.uuid(), slug]), v);

@Controller('v1')
@UseGuards(AuthGuard)
export class SocialController {
  constructor(
    private readonly follows: FollowsService,
    private readonly posts: PostsService,
    private readonly stories: StoriesService,
    private readonly communities: CommunitiesService,
  ) {}

  // ---------------------------------------------------------------- follows

  @Post('users/:id/follow')
  @HttpCode(200)
  follow(@Auth() a: AccessClaims, @Param('id') uid: string) {
    return this.follows.follow(a.userId, id(uid));
  }

  @Delete('users/:id/follow')
  unfollow(@Auth() a: AccessClaims, @Param('id') uid: string) {
    return this.follows.unfollow(a.userId, id(uid));
  }

  @Get('users/:id/followers')
  followers(@Auth() a: AccessClaims, @Param('id') uid: string, @Query() q: unknown) {
    return this.follows.list(a.userId, id(uid), 'followers', parse(Page(100, 50), q));
  }

  @Get('users/:id/following')
  following(@Auth() a: AccessClaims, @Param('id') uid: string, @Query() q: unknown) {
    return this.follows.list(a.userId, id(uid), 'following', parse(Page(100, 50), q));
  }

  @Get('me/follow-requests')
  requests(@Auth() a: AccessClaims) {
    return this.follows.requests(a.userId);
  }

  @Post('me/follow-requests/:userId')
  @HttpCode(204)
  async respond(@Auth() a: AccessClaims, @Param('userId') uid: string, @Body() body: unknown) {
    await this.follows.respond(a.userId, id(uid), parse(z.object({ approve: z.boolean() }).strict(), body).approve);
  }

  @Delete('me/followers/:userId')
  @HttpCode(204)
  async removeFollower(@Auth() a: AccessClaims, @Param('userId') uid: string) {
    await this.follows.removeFollower(a.userId, id(uid));
  }

  // ---------------------------------------------------------------- posts

  @Get('feed')
  feed(@Auth() a: AccessClaims, @Query() q: unknown) {
    return this.posts.feed(a.userId, parse(Page(50, 20), q));
  }

  @Get('users/:id/posts')
  userPosts(@Auth() a: AccessClaims, @Param('id') uid: string, @Query() q: unknown) {
    return this.posts.byUser(a.userId, id(uid), parse(Page(50, 20), q));
  }

  /** 201 for a new post, 200 when the clientId was already used (a retry). */
  @Post('posts')
  async createPost(@Auth() a: AccessClaims, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.posts.create(a.userId, parse(CreatePost, body));
    reply.status(r.duplicate ? 200 : 201);
    return r;
  }

  @Get('posts/:id')
  getPost(@Auth() a: AccessClaims, @Param('id') pid: string) {
    return this.posts.get(a.userId, id(pid));
  }

  @Patch('posts/:id')
  updatePost(@Auth() a: AccessClaims, @Param('id') pid: string, @Body() body: unknown) {
    return this.posts.update(a.userId, id(pid), parse(PostPatch, body));
  }

  @Delete('posts/:id')
  @HttpCode(204)
  async deletePost(@Auth() a: AccessClaims, @Param('id') pid: string) {
    await this.posts.delete(a.userId, id(pid));
  }

  @Put('posts/:id/like')
  like(@Auth() a: AccessClaims, @Param('id') pid: string, @Body() body: unknown) {
    return this.posts.like(a.userId, id(pid), parse(LikeBody, body).liked);
  }

  @Get('posts/:id/likes')
  likes(@Auth() a: AccessClaims, @Param('id') pid: string) {
    return this.posts.likes(a.userId, id(pid));
  }

  @Get('posts/:id/comments')
  comments(@Auth() a: AccessClaims, @Param('id') pid: string, @Query() q: unknown) {
    return this.posts.comments(a.userId, id(pid), parse(Page(100, 50), q));
  }

  @Post('posts/:id/comments')
  comment(@Auth() a: AccessClaims, @Param('id') pid: string, @Body() body: unknown) {
    return this.posts.comment(a.userId, id(pid), parse(CommentBody, body).body);
  }

  @Delete('comments/:id')
  @HttpCode(204)
  async deleteComment(@Auth() a: AccessClaims, @Param('id') cid: string) {
    await this.posts.deleteComment(a.userId, id(cid));
  }

  /** Community moderators remove (or restore) a post. */
  @Post('posts/:id/moderation')
  @HttpCode(204)
  async moderate(@Auth() a: AccessClaims, @Param('id') pid: string, @Body() body: unknown) {
    const { removed, reason } = parse(ModerationBody, body);
    await this.posts.moderate(a.userId, id(pid), removed, reason);
  }

  // ---------------------------------------------------------------- stories

  @Get('stories')
  tray(@Auth() a: AccessClaims) {
    return this.stories.tray(a.userId);
  }

  @Post('stories')
  createStory(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.stories.create(a.userId, parse(CreateStory, body));
  }

  @Get('stories/:id')
  story(@Auth() a: AccessClaims, @Param('id') sid: string) {
    return this.stories.get(a.userId, id(sid));
  }

  @Delete('stories/:id')
  @HttpCode(204)
  async deleteStory(@Auth() a: AccessClaims, @Param('id') sid: string) {
    await this.stories.delete(a.userId, id(sid));
  }

  @Post('stories/:id/views')
  @HttpCode(204)
  async viewStory(@Auth() a: AccessClaims, @Param('id') sid: string) {
    await this.stories.markViewed(a.userId, id(sid));
  }

  @Get('stories/:id/views')
  storyViewers(@Auth() a: AccessClaims, @Param('id') sid: string) {
    return this.stories.viewers(a.userId, id(sid));
  }

  @Get('users/:id/stories')
  userStories(@Auth() a: AccessClaims, @Param('id') uid: string) {
    return this.stories.byUser(a.userId, id(uid));
  }

  // ---------------------------------------------------------------- communities

  @Post('communities')
  createCommunity(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.communities.create(a.userId, parse(CreateCommunity, body));
  }

  /** Search by name or address; with no q, the communities you belong to or asked to join. */
  @Get('communities')
  searchCommunities(@Auth() a: AccessClaims, @Query() q: unknown) {
    const { q: text, limit } = parse(CommunityQuery, q);
    return this.communities.search(a.userId, text, limit);
  }

  @Get('communities/:ref')
  community(@Auth() a: AccessClaims, @Param('ref') ref: string) {
    return this.communities.get(a.userId, communityRef(ref));
  }

  @Patch('communities/:id')
  updateCommunity(@Auth() a: AccessClaims, @Param('id') cid: string, @Body() body: unknown) {
    return this.communities.update(a.userId, id(cid), parse(CommunityPatch, body));
  }

  @Delete('communities/:id')
  @HttpCode(204)
  async deleteCommunity(@Auth() a: AccessClaims, @Param('id') cid: string) {
    await this.communities.delete(a.userId, id(cid));
  }

  @Post('communities/:id/join')
  @HttpCode(200)
  join(@Auth() a: AccessClaims, @Param('id') cid: string) {
    return this.communities.join(a.userId, id(cid));
  }

  @Delete('communities/:id/membership')
  @HttpCode(204)
  async leave(@Auth() a: AccessClaims, @Param('id') cid: string) {
    await this.communities.leave(a.userId, id(cid));
  }

  @Get('communities/:id/members')
  members(@Auth() a: AccessClaims, @Param('id') cid: string, @Query() q: unknown) {
    const { state, limit } = parse(MembersQuery, q);
    return this.communities.members(a.userId, id(cid), state, limit);
  }

  @Patch('communities/:id/members/:userId')
  setMember(@Auth() a: AccessClaims, @Param('id') cid: string, @Param('userId') uid: string, @Body() body: unknown) {
    return this.communities.setMember(a.userId, id(cid), id(uid), parse(MemberPatch, body));
  }

  @Delete('communities/:id/members/:userId')
  @HttpCode(204)
  async removeMember(@Auth() a: AccessClaims, @Param('id') cid: string, @Param('userId') uid: string) {
    await this.communities.removeMember(a.userId, id(cid), id(uid));
  }

  @Get('communities/:id/posts')
  communityPosts(@Auth() a: AccessClaims, @Param('id') cid: string, @Query() q: unknown) {
    return this.posts.byCommunity(a.userId, id(cid), parse(Page(50, 20), q));
  }
}
