import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireAuthenticatedUser } from './users';

function roundCoordinate(value: number) {
  return Math.round(value * 1000) / 1000;
}

export const debugCurrentIdentity = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    return {
      tokenIdentifier: identity.tokenIdentifier,
      subject: identity.subject,
      issuer: identity.issuer,
      name: identity.name ?? null,
      email: identity.email ?? null,
      nickname: identity.nickname ?? null,
      preferredUsername: identity.preferredUsername ?? null,
      givenName: identity.givenName ?? null,
      familyName: identity.familyName ?? null,
    };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('You must be signed in to upload dataset sessions.');
    }
    await requireAuthenticatedUser(ctx);

    return await ctx.storage.generateUploadUrl();
  },
});

export const createSession = mutation({
  args: {
    sessionId: v.string(),
    storageId: v.id('_storage'),
    fileName: v.string(),
    fileType: v.string(),
    durationMillis: v.number(),
    startedAt: v.string(),
    endedAt: v.string(),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    locationAccuracy: v.optional(v.number()),
    locationName: v.optional(v.string()),
    device: v.string(),
    fileSizeBytes: v.optional(v.number()),
    uploadedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('You must be signed in to save dataset sessions.');
    }
    await requireAuthenticatedUser(ctx);

    const contributorUsername = identity.preferredUsername ?? undefined;
    const contributorEmail = identity.email ?? undefined;
    const contributorFullName = [identity.givenName, identity.familyName].filter(Boolean).join(' ');
    const contributorName = [
      identity.name,
      contributorFullName,
      identity.nickname,
      contributorUsername,
      contributorEmail,
    ].find((value) => value !== undefined && value.trim().length > 0);

    return await ctx.db.insert('sessions', {
      ...args,
      contributorId: identity.tokenIdentifier,
      contributorClerkUserId: identity.subject,
      contributorUsername,
      contributorName,
      contributorEmail,
      createdAt: Date.now(),
    });
  },
});

export const listRecentSessions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    return await ctx.db
      .query('sessions')
      .withIndex('by_contributor_id_and_created_at', (q) =>
        q.eq('contributorId', identity.tokenIdentifier)
      )
      .order('desc')
      .take(20);
  },
});

export const listMapSessions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_contributor_id_and_created_at', (q) =>
        q.eq('contributorId', identity.tokenIdentifier)
      )
      .order('desc')
      .take(250);

    return sessions
      .filter((session) => session.latitude !== undefined && session.longitude !== undefined)
      .map((session) => ({
        id: session._id,
        sessionId: session.sessionId,
        latitude: roundCoordinate(session.latitude as number),
        longitude: roundCoordinate(session.longitude as number),
        startedAt: session.startedAt,
        createdAt: session.createdAt,
        durationMillis: session.durationMillis,
      }));
  },
});

export const listPredictionSessions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_contributor_id_and_created_at', (q) =>
        q.eq('contributorId', identity.tokenIdentifier)
      )
      .order('desc')
      .take(30);

    return sessions.map((session) => ({
      id: session._id,
      sessionId: session.sessionId,
      fileName: session.fileName,
      fileType: session.fileType,
      durationMillis: session.durationMillis,
      startedAt: session.startedAt,
      createdAt: session.createdAt,
      fileSizeBytes: session.fileSizeBytes ?? null,
    }));
  },
});

export const getSessionPredictionUrl = query({
  args: {
    sessionId: v.id('sessions'),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('You must be signed in to use uploaded collection sessions.');
    }

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.contributorId !== identity.tokenIdentifier) {
      throw new Error('Collection session not found for this contributor.');
    }

    const url = await ctx.storage.getUrl(session.storageId);
    if (!url) {
      throw new Error('Collection session file is no longer available.');
    }

    return {
      url,
      fileName: session.fileName,
      fileType: session.fileType,
    };
  },
});
