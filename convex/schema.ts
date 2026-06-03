import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  sessions: defineTable({
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
    contributorId: v.optional(v.string()),
    contributorClerkUserId: v.optional(v.string()),
    contributorUsername: v.optional(v.string()),
    contributorName: v.optional(v.string()),
    contributorEmail: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    uploadedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_session_id', ['sessionId'])
    .index('by_contributor_id_and_created_at', ['contributorId', 'createdAt'])
    .index('by_created_at', ['createdAt']),
});
