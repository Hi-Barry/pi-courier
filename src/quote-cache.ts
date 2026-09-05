/**
 * Reply-quote ring cache (issue #56 票5) — pure, in-memory, no I/O.
 *
 * The Matrix transport records every inbound message's event_id → excerpt
 * (per room, FIFO eviction at MAX_ENTRIES_PER_ROOM) so a later reply to a
 * historical message can carry a short quote of the referenced text into the
 * prompt. This is how "这个"/"上面那个" become resolvable for the agent.
 *
 * Deliberately memory-bounded: 50 entries/room, excerpt capped at 200 chars.
 * Cache misses are a normal, silent downgrade — quotes are best-effort context.
 */

/** A cleaned one-line excerpt of a quoted message plus its sender. */
export interface QuoteEntry {
  username: string;
  excerpt: string;
}

export interface QuoteCache {
  /** Record a message for later quote lookups in that room. */
  record(roomId: string, eventId: string, entry: QuoteEntry): void;
  /** The recorded entry, or undefined when unknown (miss = silent no-quote). */
  lookup(roomId: string, eventId: string): QuoteEntry | undefined;
}

/** Ring capacity per room; beyond this the oldest messages fall out. */
export const MAX_ENTRIES_PER_ROOM = 50;

/** Excerpt cap: enough context to identify a message, small enough for a prompt prefix. */
export const EXCERPT_MAX_CHARS = 200;

/** Single-line, trimmed excerpt capped at EXCERPT_MAX_CHARS ("…" marks truncation). */
export function toExcerpt(body: string, max = EXCERPT_MAX_CHARS): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Per-room FIFO cache. Insertion-ordered Maps give O(1) refresh/evict:
 * re-recording an existing event id deletes then re-inserts it, so the ring
 * evicts by last-seen order and a refresh never wastes a slot.
 */
export function createQuoteCache(): QuoteCache {
  const rooms = new Map<string, Map<string, QuoteEntry>>();
  return {
    record(roomId: string, eventId: string, entry: QuoteEntry): void {
      if (!eventId || !entry.excerpt) return;
      let room = rooms.get(roomId);
      if (!room) {
        room = new Map();
        rooms.set(roomId, room);
      }
      room.delete(eventId);
      room.set(eventId, entry);
      while (room.size > MAX_ENTRIES_PER_ROOM) {
        const oldest = room.keys().next().value;
        if (oldest === undefined) break;
        room.delete(oldest);
      }
    },
    lookup(roomId: string, eventId: string): QuoteEntry | undefined {
      return rooms.get(roomId)?.get(eventId);
    },
  };
}
