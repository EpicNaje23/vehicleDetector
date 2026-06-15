import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

type Role = 'user' | 'admin';
type AuthCtx = QueryCtx | MutationCtx;

function displayNameFromIdentity(identity: Awaited<ReturnType<AuthCtx['auth']['getUserIdentity']>>) {
  if (!identity) {
    return undefined;
  }

  const fullName = [identity.givenName, identity.familyName].filter(Boolean).join(' ');
  return [
    identity.name,
    fullName,
    identity.nickname,
    identity.preferredUsername,
    identity.email,
  ].find((value) => value !== undefined && value.trim().length > 0);
}

export async function getCurrentConvexUser(ctx: AuthCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return await ctx.db
    .query('users')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
    .unique();
}

export async function requireAuthenticatedUser(ctx: AuthCtx) {
  const user = await getCurrentConvexUser(ctx);
  if (!user) {
    throw new Error('Authentication required.');
  }

  return user;
}

export async function requireAdminUser(ctx: AuthCtx) {
  const user = await requireAuthenticatedUser(ctx);
  if (user.role !== 'admin') {
    throw new Error('Admin access required.');
  }

  return user;
}

export const createOrGetCurrentUser = mutation({
  args: {},
  handler: async (ctx): Promise<Doc<'users'>> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Authentication required.');
    }

    const existingUser = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', identity.subject))
      .unique();

    if (existingUser) {
      const nextEmail = identity.email ?? undefined;
      const nextName = displayNameFromIdentity(identity);
      const updates: Partial<Pick<Doc<'users'>, 'email' | 'name' | 'updatedAt'>> = {};

      if (existingUser.email !== nextEmail) {
        updates.email = nextEmail;
      }
      if (existingUser.name !== nextName) {
        updates.name = nextName;
      }

      if (Object.keys(updates).length > 0) {
        updates.updatedAt = Date.now();
        await ctx.db.patch(existingUser._id, updates);
        return {
          ...existingUser,
          ...updates,
        };
      }

      return existingUser;
    }

    const now = Date.now();
    const userId = await ctx.db.insert('users', {
      clerkUserId: identity.subject,
      email: identity.email ?? undefined,
      name: displayNameFromIdentity(identity),
      role: 'user' as Role,
      createdAt: now,
      updatedAt: now,
    });

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error('Unable to create user.');
    }

    return user;
  },
});

export const getMe = query({
  args: {},
  handler: async (ctx): Promise<Doc<'users'> | null> => {
    return await getCurrentConvexUser(ctx);
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx): Promise<Doc<'users'>[]> => {
    await requireAdminUser(ctx);

    return await ctx.db.query('users').order('desc').take(500);
  },
});

export const promoteUserToAdmin = mutation({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<Doc<'users'>> => {
    await requireAdminUser(ctx);

    const targetUser = await ctx.db.get(args.userId);
    if (!targetUser) {
      throw new Error('Target user not found.');
    }
    if (targetUser.role === 'admin') {
      return targetUser;
    }

    const updates = {
      role: 'admin' as const,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(args.userId, updates);

    return {
      ...targetUser,
      ...updates,
    };
  },
});

export const demoteAdminToUser = mutation({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<Doc<'users'>> => {
    const currentAdmin = await requireAdminUser(ctx);
    const targetUser = await ctx.db.get(args.userId);
    if (!targetUser) {
      throw new Error('Target user not found.');
    }
    if (targetUser._id === currentAdmin._id) {
      throw new Error('Admins cannot demote themselves.');
    }
    if (targetUser.role === 'user') {
      return targetUser;
    }

    const updates = {
      role: 'user' as const,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(args.userId, updates);

    return {
      ...targetUser,
      ...updates,
    };
  },
});
