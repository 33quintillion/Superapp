import { Body, Controller, Delete, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/token.service';
import { GroupsService, MAX_GROUP_MEMBERS } from './groups.service';

const id = (v: string) => parse(z.uuid(), v);
const policy = z.enum(['everyone', 'admins']);
const title = z.string().trim().min(1).max(100);
const description = z.string().trim().max(500);

const CreateGroup = z
  .object({ title, description: description.default(''), memberIds: z.array(z.uuid()).max(MAX_GROUP_MEMBERS - 1).default([]) })
  .strict();

const GroupPatch = z
  .object({ title, description, sendPolicy: policy, infoPolicy: policy, addPolicy: policy })
  .partial()
  .strict();

const AddMembers = z.object({ userIds: z.array(z.uuid()).min(1).max(MAX_GROUP_MEMBERS) }).strict();
const RolePatch = z.object({ role: z.enum(['owner', 'admin', 'member']) }).strict();

@Controller('v1/conversations')
@UseGuards(AuthGuard)
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post('groups')
  create(@Auth() a: AccessClaims, @Body() body: unknown) {
    return this.groups.create(a.userId, parse(CreateGroup, body));
  }

  @Patch(':id/group')
  update(@Auth() a: AccessClaims, @Param('id') cid: string, @Body() body: unknown) {
    return this.groups.update(a.userId, id(cid), parse(GroupPatch, body));
  }

  @Post(':id/members')
  @HttpCode(200)
  add(@Auth() a: AccessClaims, @Param('id') cid: string, @Body() body: unknown) {
    return this.groups.addMembers(a.userId, id(cid), parse(AddMembers, body).userIds);
  }

  @Patch(':id/members/:userId')
  role(@Auth() a: AccessClaims, @Param('id') cid: string, @Param('userId') uid: string, @Body() body: unknown) {
    return this.groups.setRole(a.userId, id(cid), id(uid), parse(RolePatch, body).role);
  }

  /** Removes a member, or leaves the group when userId is your own id. */
  @Delete(':id/members/:userId')
  @HttpCode(204)
  async remove(@Auth() a: AccessClaims, @Param('id') cid: string, @Param('userId') uid: string) {
    await this.groups.removeMember(a.userId, id(cid), id(uid));
  }
}
