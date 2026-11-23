export interface ParsedSegmentInput {
  order: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  label?: string;
  rawLine: string;
  lineNumber: number;
}

export interface TimestampLineIssue {
  line: number;
  text: string;
  message: string;
}

export interface TimestampParseResult {
  validSegments: ParsedSegmentInput[];
  lineErrors: TimestampLineIssue[];
  warnings: TimestampLineIssue[];
  totalLines: number;
  validCount: number;
  hasErrors: boolean;
  totalDurationSeconds: number;
}

/**
 * Parses time strings like "01:23:45", "1:23:45", "05:20", "5:20", "90s" into numerical seconds.
 */
export function parseTimeToSeconds(raw: string): number | null {
  if (!raw) return null;
  const clean = raw.trim().toLowerCase();

  // If already pure seconds e.g. "45" or "45s"
  if (/^\d+(\.\d+)?s?$/.test(clean)) {
    const val = Number.parseFloat(clean.replace('s', ''));
    return Number.isFinite(val) && val >= 0 ? val : null;
  }

  // Timecode with colons: HH:MM:SS or MM:SS or H:MM:SS
  const parts = clean.split(':').map((p) => Number.parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }

  return null;
}

/**
 * Formats numerical seconds into "HH:MM:SS" or "MM:SS".
 */
export function formatSecondsToTimecode(totalSec: number, forceHours = false): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '00:00';
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  const mStr = String(m).padStart(2, '0');
  const sStr = String(s).padStart(2, '0');

  if (h > 0 || forceHours) {
    return `${String(h).padStart(2, '0')}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
}

const SEPARATOR_REGEX = /\s*(?:[-–—]|->|to)\s*/i;
const TIMECODE_PART_REGEX = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d+)?\b|\b\d+s\b/gi;

/**
 * Parses a single multiline timestamp input containing one segment per line.
 * Example:
 * 00:05:20 - 00:06:45
 * 00:12:10 - 00:13:30 Insane clutch
 * 00:28:00 to 00:30:15
 */
export function parseMultilineTimestamps(
  input: string,
  sourceDurationSec?: number
): TimestampParseResult {
  const rawLines = input.split(/\r?\n/);
  const validSegments: ParsedSegmentInput[] = [];
  const lineErrors: TimestampLineIssue[] = [];
  const warnings: TimestampLineIssue[] = [];

  let nonEmptyLineCount = 0;
  const seenRanges = new Map<string, number>();

  rawLines.forEach((rawLine, index) => {
    const lineNum = index + 1;
    const trimmed = rawLine.trim();

    // Ignore empty lines and comments (# or //)
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      return;
    }

    nonEmptyLineCount++;

    // Find timecodes in the line
    const timeMatches = trimmed.match(TIMECODE_PART_REGEX);

    if (!timeMatches || timeMatches.length < 2) {
      lineErrors.push({
        line: lineNum,
        text: trimmed,
        message: 'Must contain both start and end timecodes (e.g. 00:05:20 - 00:06:45)',
      });
      return;
    }

    const startStr = timeMatches[0];
    const endStr = timeMatches[1];

    const startSeconds = parseTimeToSeconds(startStr);
    const endSeconds = parseTimeToSeconds(endStr);

    if (startSeconds === null || endSeconds === null) {
      lineErrors.push({
        line: lineNum,
        text: trimmed,
        message: `Could not parse timestamps "${startStr}" or "${endStr}"`,
      });
      return;
    }

    if (endSeconds <= startSeconds) {
      lineErrors.push({
        line: lineNum,
        text: trimmed,
        message: `End time (${endStr}) must be after start time (${startStr})`,
      });
      return;
    }

    const durationSeconds = Math.round((endSeconds - startSeconds) * 10) / 10;

    if (durationSeconds < 2) {
      lineErrors.push({
        line: lineNum,
        text: trimmed,
        message: `Segment duration (${durationSeconds}s) is too short (minimum 2s)`,
      });
      return;
    }

    // YouTube Shorts allows up to 180s (3 minutes)
    if (durationSeconds > 180) {
      warnings.push({
        line: lineNum,
        text: trimmed,
        message: `Segment duration (${durationSeconds}s) exceeds 180s (YouTube Shorts maximum is 3 minutes)`,
      });
    }

    // Check bounds with source video duration if known
    if (typeof sourceDurationSec === 'number' && sourceDurationSec > 0) {
      if (startSeconds >= sourceDurationSec) {
        lineErrors.push({
          line: lineNum,
          text: trimmed,
          message: `Start time (${startStr}) is beyond video duration (${formatSecondsToTimecode(sourceDurationSec)})`,
        });
        return;
      }
      if (endSeconds > sourceDurationSec) {
        lineErrors.push({
          line: lineNum,
          text: trimmed,
          message: `End time (${endStr}) exceeds video duration (${formatSecondsToTimecode(sourceDurationSec)})`,
        });
        return;
      }
    }

    // Extract any remaining text as optional label/title
    let label = trimmed;
    label = label.replace(startStr, '').replace(endStr, '').replace(SEPARATOR_REGEX, ' ').trim();
    label = label.replace(/^[-–—:,.\s]+|[-–—:,.\s]+$/g, '').slice(0, 80);

    // Duplicate detection
    const rangeKey = `${startSeconds.toFixed(1)}-${endSeconds.toFixed(1)}`;
    if (seenRanges.has(rangeKey)) {
      const prevLine = seenRanges.get(rangeKey);
      warnings.push({
        line: lineNum,
        text: trimmed,
        message: `Duplicate range identical to line ${prevLine} (${startStr} - ${endStr})`,
      });
    } else {
      seenRanges.set(rangeKey, lineNum);
    }

    validSegments.push({
      order: validSegments.length + 1,
      startSeconds,
      endSeconds,
      durationSeconds,
      label: label || undefined,
      rawLine: trimmed,
      lineNumber: lineNum,
    });
  });

  // Check for suspicious segment overlaps
  for (let i = 0; i < validSegments.length; i++) {
    for (let j = i + 1; j < validSegments.length; j++) {
      const a = validSegments[i];
      const b = validSegments[j];
      const overlapStart = Math.max(a.startSeconds, b.startSeconds);
      const overlapEnd = Math.min(a.endSeconds, b.endSeconds);
      if (overlapEnd - overlapStart > 5) {
        const overlapDur = Math.round(overlapEnd - overlapStart);
        warnings.push({
          line: b.lineNumber,
          text: b.rawLine,
          message: `Line ${b.lineNumber} overlaps line ${a.lineNumber} by ${overlapDur}s (${formatSecondsToTimecode(overlapStart)} - ${formatSecondsToTimecode(overlapEnd)})`,
        });
      }
    }
  }

  const totalDurationSeconds = validSegments.reduce((acc, s) => acc + s.durationSeconds, 0);

  return {
    validSegments,
    lineErrors,
    warnings,
    totalLines: nonEmptyLineCount,
    validCount: validSegments.length,
    hasErrors: lineErrors.length > 0,
    totalDurationSeconds,
  };
}
