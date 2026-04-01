import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

import {
  _initTestDatabase,
  getUncondensedSummaries,
  getUnsummarizedMessages,
  getSummariesForChat,
  getSummarySources,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import type { NewMessage } from './types.js';

// ---- Dynamic config overrides ----
// Use small values so tests don't need hundreds of messages.
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 19999,
  FRESH_TAIL_COUNT: 4,
  LEAF_CHUNK_SIZE: 5,
  CONDENSATION_THRESHOLD: 3,
  SUMMARY_MODEL: 'test-model',
  MAX_SUMMARY_TOKENS: 300,
}));

// Import the module under test AFTER mock registration so it picks up overrides.
const { compactIfNeeded, summarizeChunk, summarizeSummaries } = await import(
  './memory-compactor.js'
);

// ---- Helpers ----

const CHAT_JID = 'test-group@g.us';

function makeMessage(index: number, extra?: Partial<NewMessage>): NewMessage {
  return {
    id: `msg-${index}`,
    chat_jid: CHAT_JID,
    sender: `user-${(index % 3) + 1}@s.whatsapp.net`,
    sender_name: `User${(index % 3) + 1}`,
    content: `Message number ${index} about topic-${index}`,
    timestamp: `2024-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    ...extra,
  };
}

function seedMessages(count: number): void {
  storeChatMetadata(CHAT_JID, '2024-01-01T00:00:00.000Z');
  for (let i = 1; i <= count; i++) {
    storeMessage(makeMessage(i));
  }
}

/** Build a successful LLM response body. */
function llmOk(text: string): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Build a failing LLM response. */
function llmFail(): Response {
  return new Response('Internal Server Error', { status: 500 });
}

// ---- Setup ----

let fetchMock: Mock;

beforeEach(() => {
  _initTestDatabase();
  fetchMock = vi.fn(() => Promise.resolve(llmOk('Test summary of conversation.')));
  vi.stubGlobal('fetch', fetchMock);
});

// ---- Tests ----

describe('compactIfNeeded', () => {
  it('skips when fewer than LEAF_CHUNK_SIZE unsummarized messages', async () => {
    // With FRESH_TAIL_COUNT=4, we need at least 4+5=9 messages for anything
    // to be eligible. Seed only 8.
    seedMessages(8);
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID);
    expect(summaries).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates level-0 summaries for eligible message chunks', async () => {
    // LEAF_CHUNK_SIZE=5, FRESH_TAIL_COUNT=4. Need 5+4=9 messages minimum.
    // With 14 messages: 14-4=10 eligible, 10/5=2 full chunks.
    seedMessages(14);
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID, 0);
    expect(summaries).toHaveLength(2);

    // Each summary should link to 5 source messages
    for (const s of summaries) {
      expect(s.level).toBe(0);
      expect(s.message_count).toBe(5);
      const sources = getSummarySources(s.id);
      expect(sources).toHaveLength(5);
      expect(sources.every((src) => src.source_type === 'message')).toBe(true);
    }
  });

  it('does not create summaries for partial trailing chunks', async () => {
    // 12 messages: 12-4=8 eligible, 8/5=1 full chunk + 3 leftover (skipped)
    seedMessages(12);
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID, 0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].message_count).toBe(5);
  });

  it('protects fresh tail from summarization', async () => {
    // 9 messages: 9-4=5 eligible. Exactly 1 chunk.
    seedMessages(9);
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID, 0);
    expect(summaries).toHaveLength(1);

    // The most recent 4 messages (ids msg-6..msg-9) should NOT be source ids
    const sources = getSummarySources(summaries[0].id);
    const sourceIds = sources.map((s) => s.source_id);
    expect(sourceIds).not.toContain('msg-6');
    expect(sourceIds).not.toContain('msg-7');
    expect(sourceIds).not.toContain('msg-8');
    expect(sourceIds).not.toContain('msg-9');
    // But msg-1..msg-5 should be
    for (let i = 1; i <= 5; i++) {
      expect(sourceIds).toContain(`msg-${i}`);
    }
  });

  it('is idempotent: running twice does not create duplicate summaries', async () => {
    seedMessages(14);
    await compactIfNeeded(CHAT_JID);
    const firstRun = getSummariesForChat(CHAT_JID, 0);

    await compactIfNeeded(CHAT_JID);
    const secondRun = getSummariesForChat(CHAT_JID, 0);

    expect(secondRun).toHaveLength(firstRun.length);
  });
});

describe('condensation (level roll-up)', () => {
  it('creates level-1 summary when CONDENSATION_THRESHOLD level-0 summaries exist', async () => {
    // CONDENSATION_THRESHOLD=3. Need 3 full chunks = 15 messages + 4 tail = 19
    seedMessages(19);
    await compactIfNeeded(CHAT_JID);

    const level0 = getSummariesForChat(CHAT_JID, 0);
    expect(level0).toHaveLength(3);

    const level1 = getSummariesForChat(CHAT_JID, 1);
    expect(level1).toHaveLength(1);

    // Level-1 sources should be the 3 level-0 summaries
    const sources = getSummarySources(level1[0].id);
    expect(sources).toHaveLength(3);
    expect(sources.every((s) => s.source_type === 'summary')).toBe(true);

    // message_count should be the aggregate
    expect(level1[0].message_count).toBe(15);
  });

  it('does not create level-1 if fewer than CONDENSATION_THRESHOLD level-0 summaries', async () => {
    // Only 2 full chunks = 10 messages + 4 tail = 14
    seedMessages(14);
    await compactIfNeeded(CHAT_JID);

    const level0 = getSummariesForChat(CHAT_JID, 0);
    expect(level0).toHaveLength(2);

    const level1 = getSummariesForChat(CHAT_JID, 1);
    expect(level1).toHaveLength(0);
  });

  it('recurses upward: creates level-2 when enough level-1 summaries accumulate', async () => {
    // We need CONDENSATION_THRESHOLD (3) level-1 summaries.
    // Each level-1 needs CONDENSATION_THRESHOLD (3) level-0 summaries.
    // Each level-0 needs LEAF_CHUNK_SIZE (5) messages.
    // So we need 3*3*5 = 45 messages + 4 tail = 49 messages.
    // But we can only create them in batches, so we simulate multiple calls.
    // Actually — compactIfNeeded only processes messages not yet summarized,
    // so we seed them in rounds.

    // Round 1: 19 msgs → 3 level-0 → 1 level-1
    seedMessages(19);
    await compactIfNeeded(CHAT_JID);
    expect(getSummariesForChat(CHAT_JID, 1)).toHaveLength(1);

    // Round 2: add 15 more messages (ids 20-34) → 3 more level-0 → 1 more level-1
    for (let i = 20; i <= 34; i++) {
      storeMessage(makeMessage(i));
    }
    await compactIfNeeded(CHAT_JID);
    // Now we have some level-0 uncondensed and 2 level-1 total
    expect(getSummariesForChat(CHAT_JID, 1).length).toBeGreaterThanOrEqual(2);

    // Round 3: add 15 more messages (ids 35-49) → 3 more level-0 → 1 more level-1
    for (let i = 35; i <= 49; i++) {
      storeMessage(makeMessage(i));
    }
    await compactIfNeeded(CHAT_JID);

    const level1 = getSummariesForChat(CHAT_JID, 1);
    expect(level1.length).toBeGreaterThanOrEqual(3);

    const level2 = getSummariesForChat(CHAT_JID, 2);
    expect(level2).toHaveLength(1);
    expect(level2[0].level).toBe(2);
  });
});

describe('three-level summarization escalation', () => {
  it('level 1: uses LLM detail-preserving summary', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
    const result = await summarizeChunk(messages);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('Test summary of conversation.');

    // Verify the system prompt was detail-preserving
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toContain('Preserve key decisions');
  });

  it('level 2: re-summarizes aggressively when level-1 output is too long', async () => {
    // MAX_SUMMARY_TOKENS=300, threshold = 300*1.5 = 450 tokens = ~1800 chars
    const longText = 'word '.repeat(500); // ~2500 chars = ~625 tokens > 450
    fetchMock
      .mockResolvedValueOnce(llmOk(longText)) // Level 1: too long
      .mockResolvedValueOnce(llmOk('Compressed summary.')); // Level 2: compressed

    const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
    const result = await summarizeChunk(messages);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBe('Compressed summary.');

    // Second call should have the aggressive prompt
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.system).toContain('essential facts only');
  });

  it('level 3: falls back to deterministic summary when LLM fails', async () => {
    fetchMock.mockResolvedValue(llmFail());

    const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
    const result = await summarizeChunk(messages);

    expect(result).toContain('Conversation between');
    expect(result).toContain('5 messages');
    expect(result).toContain('Topics included:');
  });

  it('falls back to level-1 result when level-2 aggressive call fails', async () => {
    const longText = 'word '.repeat(500);
    fetchMock
      .mockResolvedValueOnce(llmOk(longText)) // Level 1: too long
      .mockResolvedValueOnce(llmFail()); // Level 2: fails

    const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
    const result = await summarizeChunk(messages);

    // Should fall back to the long level-1 text
    expect(result).toBe(longText);
  });
});

describe('summarizeSummaries escalation', () => {
  it('condenses summaries with LLM', async () => {
    const summaries = [
      {
        id: 's-1',
        chat_jid: CHAT_JID,
        level: 0,
        content: 'First batch summary.',
        token_estimate: 10,
        start_timestamp: '2024-01-01T00:00:01.000Z',
        end_timestamp: '2024-01-01T00:00:05.000Z',
        message_count: 5,
        created_at: '2024-01-01T01:00:00.000Z',
      },
      {
        id: 's-2',
        chat_jid: CHAT_JID,
        level: 0,
        content: 'Second batch summary.',
        token_estimate: 10,
        start_timestamp: '2024-01-01T00:00:06.000Z',
        end_timestamp: '2024-01-01T00:00:10.000Z',
        message_count: 5,
        created_at: '2024-01-01T01:00:01.000Z',
      },
    ];

    const result = await summarizeSummaries(summaries);
    expect(result).toBe('Test summary of conversation.');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toContain('condensing multiple conversation summaries');
  });

  it('falls back to deterministic when LLM fails', async () => {
    fetchMock.mockResolvedValue(llmFail());

    const summaries = [
      {
        id: 's-1',
        chat_jid: CHAT_JID,
        level: 0,
        content: 'Summary content here.',
        token_estimate: 10,
        start_timestamp: '2024-01-01T00:00:01.000Z',
        end_timestamp: '2024-01-01T00:00:05.000Z',
        message_count: 5,
        created_at: '2024-01-01T01:00:00.000Z',
      },
    ];

    const result = await summarizeSummaries(summaries);
    expect(result).toContain('Condensed 1 summaries');
    expect(result).toContain('5 messages');
  });
});

describe('chunking logic', () => {
  it('creates correct number of chunks at LEAF_CHUNK_SIZE boundaries', async () => {
    // Exactly 10 eligible messages → 2 chunks of 5
    seedMessages(14); // 14 - 4 tail = 10 eligible
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID, 0);
    expect(summaries).toHaveLength(2);
  });

  it('handles exact multiple of LEAF_CHUNK_SIZE', async () => {
    // 20 eligible → 4 chunks of 5. Need 20 + 4 tail = 24 messages.
    // With CONDENSATION_THRESHOLD=3, will also create a level-1.
    seedMessages(24);
    await compactIfNeeded(CHAT_JID);

    const level0 = getSummariesForChat(CHAT_JID, 0);
    expect(level0).toHaveLength(4);

    // 4 >= CONDENSATION_THRESHOLD (3), so level-1 should exist
    const level1 = getSummariesForChat(CHAT_JID, 1);
    expect(level1).toHaveLength(1);
  });

  it('skips trailing partial chunk', async () => {
    // 13 eligible → 2 full chunks + 3 leftover. Need 13 + 4 = 17 messages.
    seedMessages(17);
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID, 0);
    expect(summaries).toHaveLength(2);
  });
});

describe('source links', () => {
  it('level-0 summaries have correct message source links', async () => {
    seedMessages(9); // 5 eligible, 1 chunk
    await compactIfNeeded(CHAT_JID);

    const summaries = getSummariesForChat(CHAT_JID, 0);
    expect(summaries).toHaveLength(1);

    const sources = getSummarySources(summaries[0].id);
    expect(sources).toHaveLength(5);
    for (const src of sources) {
      expect(src.source_type).toBe('message');
    }
  });

  it('level-1 summaries have correct summary source links', async () => {
    seedMessages(19); // 15 eligible, 3 chunks → triggers condensation
    await compactIfNeeded(CHAT_JID);

    const level1 = getSummariesForChat(CHAT_JID, 1);
    expect(level1).toHaveLength(1);

    const sources = getSummarySources(level1[0].id);
    expect(sources).toHaveLength(3);
    for (const src of sources) {
      expect(src.source_type).toBe('summary');
    }
  });
});
