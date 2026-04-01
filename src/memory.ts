import { getSummariesForChat } from './db.js';
import { MAX_CONTEXT_PREAMBLE_CHARS } from './config.js';
import { logger } from './logger.js';
import { escapeXml } from './router.js';
import { Summary } from './types.js';

/**
 * Format a date-range period string from ISO timestamps.
 * Single-day summaries show just the date; multi-day show "YYYY-MM-DD to YYYY-MM-DD".
 */
function formatPeriod(startTs: string, endTs: string): string {
  const start = startTs.slice(0, 10); // YYYY-MM-DD
  const end = endTs.slice(0, 10);
  return start === end ? start : `${start} to ${end}`;
}

/**
 * Render a single summary as an XML element string.
 */
function renderSummary(s: Summary): string {
  const period = formatPeriod(s.start_timestamp, s.end_timestamp);
  return `  <summary level="${s.level}" period="${escapeXml(period)}" messages="${s.message_count}" id="${escapeXml(s.id)}">\n    ${escapeXml(s.content)}\n  </summary>`;
}

/**
 * Assemble a context preamble from stored summaries for a chat.
 *
 * Strategy:
 * 1. Pick the highest-level summary available (the "big picture").
 * 2. Pick level-0 summaries from the last 48 hours.
 * 3. Fit within maxChars budget, dropping oldest level-0 summaries first.
 * 4. Return empty string if no summaries exist.
 */
export function assembleContextPreamble(
  chatJid: string,
  maxChars?: number,
): string {
  const budget = maxChars ?? MAX_CONTEXT_PREAMBLE_CHARS;
  const allSummaries = getSummariesForChat(chatJid);

  if (allSummaries.length === 0) return '';

  // First entry is the highest-level summary (ordered by level DESC, end_timestamp DESC)
  const bigPicture = allSummaries[0];

  // Collect level-0 summaries from the last 48 hours
  const now = new Date();
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const recentLeaves = allSummaries
    .filter((s) => s.level === 0 && s.end_timestamp >= cutoff)
    .sort((a, b) => a.end_timestamp.localeCompare(b.end_timestamp)); // oldest first

  // Build candidate list: big picture first, then recent level-0 (oldest-first)
  // Avoid duplicating the big picture if it's also a level-0 summary
  const candidates: Summary[] = [bigPicture];
  for (const leaf of recentLeaves) {
    if (leaf.id !== bigPicture.id) {
      candidates.push(leaf);
    }
  }

  // Wrap/budget calculation
  const xmlOpen = '<memory_context>\n';
  const xmlClose = '\n</memory_context>';
  const overhead = xmlOpen.length + xmlClose.length;

  // Render all candidates and trim from the end (oldest level-0) if over budget
  const rendered: string[] = candidates.map(renderSummary);

  // Always keep index 0 (big picture). Drop from the end (oldest recent leaves) first.
  while (rendered.length > 1) {
    const total =
      overhead + rendered.join('\n').length;
    if (total <= budget) break;
    // Drop the second element (oldest level-0 after big picture)
    rendered.splice(1, 1);
  }

  // If even the big picture alone exceeds budget, truncate its content
  const total = overhead + rendered[0].length;
  if (total > budget) {
    // Still return what we can — the XML wrapper + truncated big picture
    const available = budget - overhead - 100; // leave room for XML tags
    if (available <= 0) {
      logger.debug({ chatJid, budget }, 'Context preamble budget too small for any summary');
      return '';
    }
    const truncated = renderSummary({
      ...bigPicture,
      content: bigPicture.content.slice(0, available) + '...',
    });
    return `${xmlOpen}${truncated}${xmlClose}`;
  }

  return `${xmlOpen}${rendered.join('\n')}${xmlClose}`;
}
