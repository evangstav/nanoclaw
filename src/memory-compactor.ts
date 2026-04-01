/**
 * Background compaction service for agentic memory (LCM-style summarization).
 *
 * Called after an agent finishes processing a group's messages.
 * Creates a hierarchical DAG of summaries:
 *   - Level 0 (leaf): summarizes chunks of raw messages
 *   - Level 1+: condenses groups of lower-level summaries
 *
 * Uses three-level escalation for summarization:
 *   1. Detail-preserving LLM call
 *   2. Aggressive compression LLM call (if level-1 is too long)
 *   3. Deterministic fallback (if LLM fails)
 */
import {
  CREDENTIAL_PROXY_PORT,
  FRESH_TAIL_COUNT,
  LEAF_CHUNK_SIZE,
  CONDENSATION_THRESHOLD,
  SUMMARY_MODEL,
  MAX_SUMMARY_TOKENS,
} from './config.js';
import {
  getUnsummarizedMessages,
  getUncondensedSummaries,
  insertSummary,
} from './db.js';
import { logger } from './logger.js';
import type { NewMessage, Summary } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function generateId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `s-${Date.now()}-${rand}`;
}

/** Split an array into chunks of `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// LLM interaction
// ---------------------------------------------------------------------------

async function callLLM(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(
      `http://localhost:${CREDENTIAL_PROXY_PORT}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: SUMMARY_MODEL,
          max_tokens: maxTokens ?? MAX_SUMMARY_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        }),
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `LLM call failed: ${resp.status} ${resp.statusText} – ${body}`,
      );
    }

    const json = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textBlock = json.content?.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      throw new Error('LLM response contained no text block');
    }
    return textBlock.text;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Summarization with three-level escalation
// ---------------------------------------------------------------------------

function formatMessagesForSummary(messages: NewMessage[]): string {
  return messages
    .map(
      (m) =>
        `[${m.timestamp}] ${m.sender_name}: ${m.content}`,
    )
    .join('\n');
}

const DETAIL_SYSTEM_PROMPT =
  'You are a conversation summarizer. Preserve key decisions, facts, action items, and user preferences. Target: under 200 words.';

const AGGRESSIVE_SYSTEM_PROMPT =
  'Compress to essential facts only. Under 100 words. Keep only decisions, action items, and critical facts.';

const SUMMARY_CONDENSE_SYSTEM_PROMPT =
  'You are condensing multiple conversation summaries into a single higher-level summary. Preserve the most important decisions, facts, action items, and preferences. Target: under 200 words.';

const SUMMARY_CONDENSE_AGGRESSIVE_PROMPT =
  'Compress these summaries to essential facts only. Under 100 words. Keep only the most critical decisions, action items, and facts.';

/**
 * Summarize a chunk of messages using three-level escalation.
 */
export async function summarizeChunk(
  messages: NewMessage[],
): Promise<string> {
  // Level 1: detail-preserving (allow headroom for verbose responses that trigger level-2)
  try {
    const userContent = formatMessagesForSummary(messages);
    const result = await callLLM(DETAIL_SYSTEM_PROMPT, userContent, MAX_SUMMARY_TOKENS * 2);
    const tokens = estimateTokens(result);

    // Level 2: if too long, compress aggressively
    if (tokens > MAX_SUMMARY_TOKENS * 1.5) {
      try {
        return await callLLM(AGGRESSIVE_SYSTEM_PROMPT, result);
      } catch (err) {
        logger.warn({ err }, 'Aggressive summarization failed, using level-1 result');
        return result;
      }
    }

    return result;
  } catch (err) {
    // Level 3: deterministic fallback
    logger.warn({ err }, 'LLM summarization failed, using deterministic fallback');
    return deterministicFallback(messages);
  }
}

/**
 * Summarize a set of summaries into a higher-level summary using three-level escalation.
 */
export async function summarizeSummaries(
  summaries: Summary[],
): Promise<string> {
  const userContent = summaries
    .map(
      (s) =>
        `[Level ${s.level}, ${s.start_timestamp} to ${s.end_timestamp}, ${s.message_count} msgs]\n${s.content}`,
    )
    .join('\n\n');

  // Level 1: detail-preserving condensation (allow headroom for level-2 trigger)
  try {
    const result = await callLLM(SUMMARY_CONDENSE_SYSTEM_PROMPT, userContent, MAX_SUMMARY_TOKENS * 2);
    const tokens = estimateTokens(result);

    // Level 2: aggressive compression if too long
    if (tokens > MAX_SUMMARY_TOKENS * 1.5) {
      try {
        return await callLLM(SUMMARY_CONDENSE_AGGRESSIVE_PROMPT, result);
      } catch (err) {
        logger.warn({ err }, 'Aggressive summary condensation failed, using level-1 result');
        return result;
      }
    }

    return result;
  } catch (err) {
    // Level 3: deterministic fallback for summaries
    logger.warn({ err }, 'LLM summary condensation failed, using deterministic fallback');
    const totalMsgCount = summaries.reduce((acc, s) => acc + s.message_count, 0);
    const start = summaries[0]?.start_timestamp ?? 'unknown';
    const end = summaries[summaries.length - 1]?.end_timestamp ?? 'unknown';
    const snippet = summaries[0]?.content.slice(0, 200) ?? '';
    return `Condensed ${summaries.length} summaries covering ${totalMsgCount} messages from ${start} to ${end}. Key content: ${snippet}...`;
  }
}

function deterministicFallback(messages: NewMessage[]): string {
  const senders = Array.from(new Set(messages.map((m) => m.sender_name)));
  const startTime = messages[0]?.timestamp ?? 'unknown';
  const endTime = messages[messages.length - 1]?.timestamp ?? 'unknown';
  const firstContent = messages[0]?.content.slice(0, 200) ?? '';
  return `Conversation between ${senders.join(', ')} from ${startTime} to ${endTime} (${messages.length} messages). Topics included: ${firstContent}...`;
}

// ---------------------------------------------------------------------------
// Main compaction entry point
// ---------------------------------------------------------------------------

// Prevent overlapping compactions for the same chat.
// Two concurrent runs would both see the same unsummarized messages and create duplicate summaries.
const compactionInFlight = new Set<string>();

/**
 * Run background compaction for a chat. Called after agent finishes processing.
 *
 * 1. Retrieve unsummarized messages (excluding fresh tail).
 * 2. Chunk them and create level-0 summaries.
 * 3. Roll up uncondensed summaries at each level until threshold not met.
 */
export async function compactIfNeeded(chatJid: string): Promise<void> {
  if (compactionInFlight.has(chatJid)) return;
  compactionInFlight.add(chatJid);
  try {
  // Step 1: Get messages eligible for compaction
  const unsummarized = getUnsummarizedMessages(chatJid, FRESH_TAIL_COUNT);

  if (unsummarized.length < LEAF_CHUNK_SIZE) {
    return; // Not enough messages to warrant compaction
  }

  // Step 2: Create level-0 (leaf) summaries
  const chunks = chunk(unsummarized, LEAF_CHUNK_SIZE);
  for (const messageChunk of chunks) {
    // Skip partial trailing chunks that are too small
    if (messageChunk.length < LEAF_CHUNK_SIZE) {
      continue;
    }

    const content = await summarizeChunk(messageChunk);
    const tokenEstimate = estimateTokens(content);
    const totalMessageCount = messageChunk.length;
    const startTimestamp = messageChunk[0].timestamp;
    const endTimestamp = messageChunk[messageChunk.length - 1].timestamp;

    const summary: Summary = {
      id: generateId(),
      chat_jid: chatJid,
      level: 0,
      content,
      token_estimate: tokenEstimate,
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
      message_count: totalMessageCount,
      created_at: new Date().toISOString(),
    };

    const sourceIds = messageChunk.map((m) => ({
      type: 'message' as const,
      id: m.id,
    }));

    insertSummary(summary, sourceIds);
    logger.info(
      { chatJid, summaryId: summary.id, messages: totalMessageCount, tokens: tokenEstimate },
      'Created level-0 summary',
    );
  }

  // Step 3: Recursive condensation up the hierarchy
  await condenseUpward(chatJid, 0);
  } finally {
    compactionInFlight.delete(chatJid);
  }
}

/**
 * Recursively check whether enough uncondensed summaries exist at `level`
 * to roll them into a level+1 summary. Repeats upward until threshold is
 * no longer met.
 */
async function condenseUpward(
  chatJid: string,
  level: number,
): Promise<void> {
  const uncondensed = getUncondensedSummaries(chatJid, level);

  if (uncondensed.length < CONDENSATION_THRESHOLD) {
    return;
  }

  const content = await summarizeSummaries(uncondensed);
  const tokenEstimate = estimateTokens(content);
  const totalMessageCount = uncondensed.reduce(
    (acc, s) => acc + s.message_count,
    0,
  );
  const startTimestamp = uncondensed[0].start_timestamp;
  const endTimestamp = uncondensed[uncondensed.length - 1].end_timestamp;

  const summary: Summary = {
    id: generateId(),
    chat_jid: chatJid,
    level: level + 1,
    content,
    token_estimate: tokenEstimate,
    start_timestamp: startTimestamp,
    end_timestamp: endTimestamp,
    message_count: totalMessageCount,
    created_at: new Date().toISOString(),
  };

  const sourceIds = uncondensed.map((s) => ({
    type: 'summary' as const,
    id: s.id,
  }));

  insertSummary(summary, sourceIds);
  logger.info(
    {
      chatJid,
      summaryId: summary.id,
      level: level + 1,
      sources: uncondensed.length,
      tokens: tokenEstimate,
    },
    `Created level-${level + 1} summary`,
  );

  // Recurse: check if we now have enough level+1 summaries
  await condenseUpward(chatJid, level + 1);
}
