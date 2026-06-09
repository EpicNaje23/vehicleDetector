import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

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
    locationName: v.string(),
    device: v.string(),
    fileSizeBytes: v.optional(v.number()),
    uploadedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('You must be signed in to save dataset sessions.');
    }

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

    const sessions = await ctx.db.query('sessions').withIndex('by_created_at').order('desc').take(250);

    return sessions
      .filter((session) => session.latitude !== undefined && session.longitude !== undefined)
      .map((session) => ({
        id: session._id,
        latitude: roundCoordinate(session.latitude as number),
        longitude: roundCoordinate(session.longitude as number),
        locationName: session.locationName ?? 'Collection point',
        createdAt: session.createdAt,
        durationMillis: session.durationMillis,
      }));
  },
});
