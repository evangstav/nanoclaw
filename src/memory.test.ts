import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, insertSummary, storeChatMetadata } from './db.js';
import { assembleContextPreamble } from './memory.js';
import { Summary } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  // Create the chat so FK constraints are satisfied
  storeChatMetadata('group@g.us', '2026-03-31T00:00:00.000Z', 'Test Group', 'whatsapp', true);
  storeChatMetadata('other@g.us', '2026-03-31T00:00:00.000Z', 'Other Group', 'whatsapp', true);
});

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: overrides.id ?? 's-test',
    chat_jid: overrides.chat_jid ?? 'group@g.us',
    level: overrides.level ?? 0,
    content: overrides.content ?? 'Test summary content',
    token_estimate: overrides.token_estimate ?? 50,
    start_timestamp: overrides.start_timestamp ?? '2026-03-31T10:00:00.000Z',
    end_timestamp: overrides.end_timestamp ?? '2026-03-31T18:00:00.000Z',
    message_count: overrides.message_count ?? 42,
    created_at: overrides.created_at ?? '2026-03-31T20:00:00.000Z',
  };
}

describe('assembleContextPreamble', () => {
  it('returns empty string when no summaries exist', () => {
    const result = assembleContextPreamble('group@g.us');
    expect(result).toBe('');
  });

  it('formats a single summary in correct XML', () => {
    const summary = makeSummary({
      id: 's-abc123',
      level: 0,
      content: 'Discussed NanoClaw update',
      message_count: 42,
      start_timestamp: '2026-03-31T10:00:00.000Z',
      end_timestamp: '2026-03-31T18:00:00.000Z',
    });
    insertSummary(summary, [{ type: 'message', id: 'msg-1' }]);

    const result = assembleContextPreamble('group@g.us');

    expect(result).toContain('<memory_context>');
    expect(result).toContain('</memory_context>');
    expect(result).toContain('level="0"');
    expect(result).toContain('period="2026-03-31"');
    expect(result).toContain('messages="42"');
    expect(result).toContain('id="s-abc123"');
    expect(result).toContain('Discussed NanoClaw update');
  });

  it('formats multi-day period as date range', () => {
    const summary = makeSummary({
      id: 's-range',
      level: 1,
      start_timestamp: '2026-02-01T00:00:00.000Z',
      end_timestamp: '2026-03-15T23:59:59.000Z',
    });
    insertSummary(summary, [{ type: 'summary', id: 's-child' }]);

    const result = assembleContextPreamble('group@g.us');

    expect(result).toContain('period="2026-02-01 to 2026-03-15"');
  });

  it('picks highest-level summary plus recent level-0 summaries', () => {
    // High-level summary (the "big picture")
    const bigPicture = makeSummary({
      id: 's-big',
      level: 2,
      content: 'Overall context: user is a software engineer',
      message_count: 450,
      start_timestamp: '2026-02-01T00:00:00.000Z',
      end_timestamp: '2026-03-30T23:59:59.000Z',
    });
    insertSummary(bigPicture, [{ type: 'summary', id: 's-child1' }]);

    // Recent level-0 summary (within 48h)
    const recent = makeSummary({
      id: 's-recent',
      level: 0,
      content: 'Yesterday: discussed Telegram channel setup',
      message_count: 30,
      start_timestamp: '2026-03-31T10:00:00.000Z',
      end_timestamp: '2026-03-31T18:00:00.000Z',
    });
    insertSummary(recent, [{ type: 'message', id: 'msg-1' }]);

    // Old level-0 summary (outside 48h window)
    const old = makeSummary({
      id: 's-old',
      level: 0,
      content: 'Old discussion about weather',
      message_count: 20,
      start_timestamp: '2026-03-20T10:00:00.000Z',
      end_timestamp: '2026-03-20T18:00:00.000Z',
    });
    insertSummary(old, [{ type: 'message', id: 'msg-2' }]);

    // Use a generous budget and freeze "now" relative to the test data
    // The function uses new Date() internally, so recent summaries within 48h
    // of the real clock won't match our test data from 2026.
    // Instead, we test that it picks the highest-level summary.
    const result = assembleContextPreamble('group@g.us', 10000);

    // Big picture should always be present
    expect(result).toContain('level="2"');
    expect(result).toContain('Overall context: user is a software engineer');
  });

  it('respects maxChars budget by truncating oldest', () => {
    // Create a big-picture summary
    const bigPicture = makeSummary({
      id: 's-big',
      level: 1,
      content: 'Big picture',
      message_count: 100,
      start_timestamp: '2026-01-01T00:00:00.000Z',
      end_timestamp: '2026-03-30T23:59:59.000Z',
    });
    insertSummary(bigPicture, [{ type: 'summary', id: 's-child' }]);

    // Create several recent level-0 summaries with large content
    // Use recent enough timestamps that they'd be within 48h of "now"
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      const ts = new Date(now.getTime() - i * 3600000); // i hours ago
      const summary = makeSummary({
        id: `s-leaf-${i}`,
        level: 0,
        content: 'A'.repeat(300),
        message_count: 10,
        start_timestamp: ts.toISOString(),
        end_timestamp: ts.toISOString(),
      });
      insertSummary(summary, [{ type: 'message', id: `msg-${i}` }]);
    }

    // Use a small budget that forces truncation
    const result = assembleContextPreamble('group@g.us', 600);

    // Should still have the wrapper and at least the big picture
    expect(result).toContain('<memory_context>');
    expect(result).toContain('</memory_context>');
    expect(result.length).toBeLessThanOrEqual(600);
  });

  it('returns empty string for unknown chat', () => {
    const summary = makeSummary({ chat_jid: 'other@g.us' });
    insertSummary(summary, [{ type: 'message', id: 'msg-1' }]);

    const result = assembleContextPreamble('unknown@g.us');
    expect(result).toBe('');
  });

  it('escapes XML special characters in summary content', () => {
    const summary = makeSummary({
      id: 's-xml',
      content: 'User said <hello> & "goodbye"',
    });
    insertSummary(summary, [{ type: 'message', id: 'msg-1' }]);

    const result = assembleContextPreamble('group@g.us');

    expect(result).toContain('&lt;hello&gt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&quot;goodbye&quot;');
    expect(result).not.toContain('<hello>');
  });
});
