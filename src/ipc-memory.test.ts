import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  insertSummary,
  searchMessages,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { processMemoryRequest } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
  };

  storeChatMetadata('main@g.us', '2024-01-01T00:00:00.000Z');
  storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

  storeMessage({
    id: 'msg-1',
    chat_jid: 'main@g.us',
    sender: 'alice@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'Discussing the project roadmap for next quarter',
    timestamp: '2024-01-01T00:00:01.000Z',
    is_from_me: false,
  });
  storeMessage({
    id: 'msg-2',
    chat_jid: 'other@g.us',
    sender: 'bob@s.whatsapp.net',
    sender_name: 'Bob',
    content: 'The project timeline has been updated',
    timestamp: '2024-01-01T00:00:02.000Z',
    is_from_me: false,
  });
  storeMessage({
    id: 'msg-3',
    chat_jid: 'main@g.us',
    sender: 'carol@s.whatsapp.net',
    sender_name: 'Carol',
    content: 'Please review the budget estimates',
    timestamp: '2024-01-01T00:00:03.000Z',
    is_from_me: false,
  });
});

// --- memory_search ---

describe('memory_search', () => {
  it('returns FTS5 results for a valid query', () => {
    const resp = processMemoryRequest(
      { type: 'memory_search', requestId: 'req-1', query: 'project', chatJid: undefined },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    expect(resp.requestId).toBe('req-1');
    const data = resp.data as Array<{ id: string }>;
    expect(data.length).toBe(2);
  });

  it('scopes search to chatJid when provided', () => {
    const resp = processMemoryRequest(
      { type: 'memory_search', requestId: 'req-2', query: 'project', chatJid: 'main@g.us' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    const data = resp.data as Array<{ id: string; chat_jid: string }>;
    expect(data.length).toBe(1);
    expect(data[0].chat_jid).toBe('main@g.us');
  });

  it('non-main group is forced to its own chatJid', () => {
    // other-group tries to search main@g.us, but should be scoped to other@g.us
    const resp = processMemoryRequest(
      { type: 'memory_search', requestId: 'req-3', query: 'project', chatJid: 'main@g.us' },
      'other-group',
      false,
      groups,
    );

    expect(resp.status).toBe('success');
    const data = resp.data as Array<{ id: string; chat_jid: string }>;
    // Should only find the message from other@g.us
    expect(data.length).toBe(1);
    expect(data[0].chat_jid).toBe('other@g.us');
  });

  it('returns error for missing query', () => {
    const resp = processMemoryRequest(
      { type: 'memory_search', requestId: 'req-4' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('error');
    expect(resp.error).toContain('Missing query');
  });

  it('returns empty array for no matches', () => {
    const resp = processMemoryRequest(
      { type: 'memory_search', requestId: 'req-5', query: 'nonexistent-xyz' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    expect(resp.data).toHaveLength(0);
  });
});

// --- memory_context ---

describe('memory_context', () => {
  it('returns summaries for a chat', () => {
    insertSummary(
      {
        id: 'sum-1',
        chat_jid: 'main@g.us',
        level: 0,
        content: 'Discussion about project roadmap',
        token_estimate: 50,
        start_timestamp: '2024-01-01T00:00:01.000Z',
        end_timestamp: '2024-01-01T00:00:03.000Z',
        message_count: 2,
        created_at: '2024-01-02T00:00:00.000Z',
      },
      [
        { type: 'message', id: 'msg-1' },
        { type: 'message', id: 'msg-3' },
      ],
    );

    const resp = processMemoryRequest(
      { type: 'memory_context', requestId: 'req-ctx-1', chatJid: 'main@g.us' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    const data = resp.data as Array<{ id: string }>;
    expect(data.length).toBe(1);
    expect(data[0].id).toBe('sum-1');
  });

  it('returns empty when no summaries exist', () => {
    const resp = processMemoryRequest(
      { type: 'memory_context', requestId: 'req-ctx-2', chatJid: 'other@g.us' },
      'other-group',
      false,
      groups,
    );

    expect(resp.status).toBe('success');
    expect(resp.data).toHaveLength(0);
  });

  it('returns error when chatJid is missing', () => {
    const resp = processMemoryRequest(
      { type: 'memory_context', requestId: 'req-ctx-3' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('error');
    expect(resp.error).toContain('Missing chatJid');
  });
});

// --- memory_expand ---

describe('memory_expand', () => {
  it('returns source messages for a level-0 summary', () => {
    insertSummary(
      {
        id: 'sum-expand',
        chat_jid: 'main@g.us',
        level: 0,
        content: 'Summary of messages',
        token_estimate: 30,
        start_timestamp: '2024-01-01T00:00:01.000Z',
        end_timestamp: '2024-01-01T00:00:03.000Z',
        message_count: 2,
        created_at: '2024-01-02T00:00:00.000Z',
      },
      [
        { type: 'message', id: 'msg-1' },
        { type: 'message', id: 'msg-3' },
      ],
    );

    const resp = processMemoryRequest(
      { type: 'memory_expand', requestId: 'req-exp-1', summaryId: 'sum-expand' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    const data = resp.data as { messages?: Array<{ id: string }>; summaries?: unknown[] };
    expect(data.messages).toHaveLength(2);
    expect(data.messages![0].id).toBe('msg-1');
    expect(data.messages![1].id).toBe('msg-3');
  });

  it('returns sub-summaries for a higher-level summary', () => {
    // Create a level-0 summary first
    insertSummary(
      {
        id: 'sum-child',
        chat_jid: 'main@g.us',
        level: 0,
        content: 'Child summary',
        token_estimate: 30,
        start_timestamp: '2024-01-01T00:00:01.000Z',
        end_timestamp: '2024-01-01T00:00:03.000Z',
        message_count: 2,
        created_at: '2024-01-02T00:00:00.000Z',
      },
      [
        { type: 'message', id: 'msg-1' },
        { type: 'message', id: 'msg-3' },
      ],
    );

    // Create a level-1 summary that references the level-0
    insertSummary(
      {
        id: 'sum-parent',
        chat_jid: 'main@g.us',
        level: 1,
        content: 'Parent summary',
        token_estimate: 20,
        start_timestamp: '2024-01-01T00:00:01.000Z',
        end_timestamp: '2024-01-01T00:00:03.000Z',
        message_count: 2,
        created_at: '2024-01-03T00:00:00.000Z',
      },
      [{ type: 'summary', id: 'sum-child' }],
    );

    const resp = processMemoryRequest(
      { type: 'memory_expand', requestId: 'req-exp-2', summaryId: 'sum-parent' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    const data = resp.data as { messages?: unknown[]; summaries?: Array<{ id: string }> };
    expect(data.summaries).toHaveLength(1);
    expect(data.summaries![0].id).toBe('sum-child');
  });

  it('returns error when summaryId is missing', () => {
    const resp = processMemoryRequest(
      { type: 'memory_expand', requestId: 'req-exp-3' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('error');
    expect(resp.error).toContain('Missing summaryId');
  });

  it('returns empty data for nonexistent summary', () => {
    const resp = processMemoryRequest(
      { type: 'memory_expand', requestId: 'req-exp-4', summaryId: 'nonexistent' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('success');
    const data = resp.data as { messages?: unknown[]; summaries?: unknown[] };
    // Nonexistent summary returns empty arrays
    expect(data.messages).toEqual([]);
    expect(data.summaries).toEqual([]);
  });
});

// --- Unknown type ---

describe('unknown memory request type', () => {
  it('returns error for unknown type', () => {
    const resp = processMemoryRequest(
      { type: 'memory_unknown', requestId: 'req-unk' },
      'whatsapp_main',
      true,
      groups,
    );

    expect(resp.status).toBe('error');
    expect(resp.error).toContain('Unknown memory request type');
  });
});
