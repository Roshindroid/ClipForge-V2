import type { AiMetadataSuggestion, AiProviderStatus } from '../src/types.ts';

export function getAiProviderStatus(): AiProviderStatus {
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
}

export interface GenerateYouTubeMetadataInput {
  provider?: 'both' | 'auto' | 'anthropic' | 'openai';
  clipTitle: string;
  projectTitle?: string;
  durationSec?: number;
  existingTitle?: string;
  existingHook?: string;
  existingDescription?: string;
  existingHashtags?: string[];
  existingTags?: string[];
  existingAlternativeTitles?: string[];
  modifyInstruction?: string;
}

function normalizeHashtags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['#shorts', '#highlights'];
  const list = raw
    .map((h) => {
      const s = String(h).trim().replace(/\s+/g, '');
      if (!s) return '';
      return s.startsWith('#') ? s : `#${s}`;
    })
    .filter(Boolean);
  const deduped = Array.from(new Set(list));
  if (!deduped.some((h) => h.toLowerCase() === '#shorts')) {
    deduped.unshift('#shorts');
  }
  return deduped.slice(0, 10);
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['shorts', 'highlights', 'stream clips'];
  const list = raw
    .map((t) => String(t).trim().replace(/^#/, ''))
    .filter(Boolean);
  return Array.from(new Set(list)).slice(0, 15);
}

function parseMetadataJson(raw: string, providerLabel: string): AiMetadataSuggestion {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: {
    title?: string;
    alternativeTitles?: unknown[];
    hookTagline?: string;
    description?: string;
    hashtags?: unknown[];
    tags?: unknown[];
  };

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
      parsed = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
    } else {
      throw new Error(`${providerLabel} returned non-JSON metadata output.`);
    }
  }

  const title = String(parsed.title || 'Unbelievable Stream Highlight #Shorts')
    .trim()
    .slice(0, 100);
  const alternativeTitles = Array.isArray(parsed.alternativeTitles)
    ? Array.from(
        new Set(
          parsed.alternativeTitles
            .map((t) => String(t).trim().slice(0, 100))
            .filter((t) => t && t !== title)
        )
      ).slice(0, 4)
    : [];
  const hookTagline = String(parsed.hookTagline || 'Wait until the final second')
    .trim()
    .slice(0, 120);
  const description = String(parsed.description || '').trim().slice(0, 500);
  const hashtags = normalizeHashtags(parsed.hashtags);
  const tags = normalizeTags(parsed.tags);

  return {
    title,
    alternativeTitles,
    hookTagline,
    description,
    hashtags,
    tags,
    providerUsed: providerLabel,
    providersUsed: [providerLabel],
  };
}

function buildModifyPrompt(input: GenerateYouTubeMetadataInput, openaiDraft?: AiMetadataSuggestion): string {
  const currentTitle = (input.existingTitle || input.clipTitle || '').trim();
  const currentHashtags = (input.existingHashtags || []).filter(Boolean).join(' ');
  const currentTags = (input.existingTags || []).filter(Boolean).join(', ');

  const lines = [
    openaiDraft
      ? 'You are the final synthesis editor. Combine the user’s already-generated YouTube Shorts metadata and the OpenAI draft below into the sharpest, highest-performing final version.'
      : 'Modify, polish, and upgrade the already-generated YouTube Shorts metadata below while keeping its true topic and creator intent.',
    `Clip name / context: "${input.clipTitle}"`,
    input.projectTitle ? `Source video title: "${input.projectTitle}"` : '',
    input.durationSec ? `Clip duration: ${input.durationSec} seconds` : '',
    '',
    '--- ALREADY GENERATED METADATA ---',
    `Current Title: "${currentTitle}"`,
    input.existingHook ? `Current Hook Tagline: "${input.existingHook}"` : '',
    input.existingDescription ? `Current Small Description: "${input.existingDescription}"` : '',
    currentHashtags ? `Current Hashtags: ${currentHashtags}` : '',
    currentTags ? `Current Searchable Tags: ${currentTags}` : '',
    input.modifyInstruction?.trim()
      ? `User Refinement Request: "${input.modifyInstruction.trim()}"`
      : '',
  ];

  if (openaiDraft) {
    lines.push(
      '',
      '--- OPENAI REFINEMENT PASS ---',
      `OpenAI Title: "${openaiDraft.title}"`,
      openaiDraft.alternativeTitles.length
        ? `OpenAI Alt Titles: ${openaiDraft.alternativeTitles.join(' | ')}`
        : '',
      `OpenAI Hook: "${openaiDraft.hookTagline}"`,
      `OpenAI Small Description: "${openaiDraft.description}"`,
      `OpenAI Hashtags: ${openaiDraft.hashtags.join(' ')}`,
      `OpenAI Searchable Tags: ${openaiDraft.tags.join(', ')}`
    );
  }

  lines.push(
    '',
    'Requirements:',
    '- Improve the already-generated Title (punchy, curiosity/outcome-driven, <= 90 chars) and include 3 distinct alternativeTitles.',
    '- Keep description SMALL and tight: 1-2 crisp sentences (<= 220 chars), no fluff or wall of text.',
    '- Provide 1 short hookTagline (<= 90 chars).',
    '- Upgrade hashtags: 5-8 relevant #hashtags always including #shorts.',
    '- Upgrade searchable tags: 8-14 high-intent comma-searchable YouTube tags (plain words/phrases, no # prefix).',
    'Return strictly valid JSON matching this schema and nothing else:',
    '{"title":"...","alternativeTitles":["...","...","..."],"hookTagline":"...","description":"...","hashtags":["#shorts","#..."],"tags":["tag 1","tag 2"]}'
  );

  return lines.filter(Boolean).join('\n');
}

function extractSafeUpstreamMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    const msg = parsed?.error?.message;
    if (typeof msg === 'string' && msg.trim()) {
      return msg
        .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/API key provided:\s*\S+/gi, 'API key provided: [redacted]')
        .trim()
        .slice(0, 180);
    }
  } catch {
    // ignore non-JSON body
  }
  return '';
}

async function callAnthropicMetadata(prompt: string, apiKey: string): Promise<AiMetadataSuggestion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const models = ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest'];
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    let lastError = 'Anthropic request failed';

    for (const model of models) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: 750,
          temperature: 0.6,
          system:
            'You are a YouTube Shorts metadata editor. Modify and improve already-generated titles, small descriptions, hashtags, and searchable tags. Respond strictly with valid JSON and no markdown fences.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        const detail = extractSafeUpstreamMessage(errBody);
        lastError = detail
          ? `Anthropic (${res.status}): ${detail}`
          : `Anthropic API returned HTTP ${res.status}`;
        if ((res.status === 404 || res.status === 400) && model !== models[models.length - 1] && detail.toLowerCase().includes('model')) {
          continue;
        }
        if (res.status === 429 || errBody.toLowerCase().includes('credit') || errBody.toLowerCase().includes('quota')) {
          throw new Error(detail ? `Anthropic quota/credit limit: ${detail}` : 'Anthropic API rate limit or quota reached.');
        }
        throw new Error(lastError);
      }

      const payload = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = payload.content?.find((c) => c.type === 'text')?.text || '';
      if (!text) throw new Error('Anthropic returned empty content.');
      return parseMetadataJson(text, `Anthropic (${model})`);
    }

    throw new Error(lastError);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAIMetadata(prompt: string, apiKey: string): Promise<AiMetadataSuggestion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const model = 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a YouTube Shorts metadata editor. Modify and improve already-generated titles, small descriptions, hashtags, and searchable tags. Respond strictly with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      const detail = extractSafeUpstreamMessage(errBody);
      if (res.status === 429 || errBody.toLowerCase().includes('quota') || errBody.toLowerCase().includes('insufficient_quota')) {
        throw new Error(detail ? `OpenAI quota/rate limit: ${detail}` : 'OpenAI API quota or rate limit reached.');
      }
      throw new Error(detail ? `OpenAI (${res.status}): ${detail}` : `OpenAI API returned HTTP ${res.status}.`);
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('OpenAI returned empty content.');
    return parseMetadataJson(text, `OpenAI (${model})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Modifies and refines already-generated YouTube Shorts title, small description, hashtags, and searchable tags
 * strictly on the backend using Anthropic, OpenAI, or BOTH together.
 */
export async function generateYouTubeMetadataWithAi(
  input: GenerateYouTubeMetadataInput
): Promise<AiMetadataSuggestion> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() || '';

  const requested = input.provider || (anthropicKey && openaiKey ? 'both' : 'auto');

  if (requested === 'anthropic' && !anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured in the server environment.');
  }
  if (requested === 'openai' && !openaiKey) {
    throw new Error('OPENAI_API_KEY is not configured in the server environment.');
  }
  if (!anthropicKey && !openaiKey) {
    throw new Error(
      'No AI provider keys configured (ANTHROPIC_API_KEY or OPENAI_API_KEY). Enter metadata manually.'
    );
  }

  const basePrompt = buildModifyPrompt(input);

  // Dual-provider pipeline: OpenAI optimizes SEO/tags/draft -> Anthropic synthesizes final Shorts title, small description, hashtags & tags
  if (requested === 'both' && anthropicKey && openaiKey) {
    const warnings: string[] = [];
    let openaiDraft: AiMetadataSuggestion | null = null;

    try {
      openaiDraft = await callOpenAIMetadata(basePrompt, openaiKey);
    } catch (err) {
      warnings.push(
        `OpenAI step skipped (${err instanceof Error ? err.message : 'request failed'})`
      );
    }

    try {
      const synthPrompt = openaiDraft ? buildModifyPrompt(input, openaiDraft) : basePrompt;
      const anthropicFinal = await callAnthropicMetadata(synthPrompt, anthropicKey);

      const mergedAltTitles = Array.from(
        new Set([
          ...anthropicFinal.alternativeTitles,
          ...(openaiDraft ? [openaiDraft.title, ...openaiDraft.alternativeTitles] : []),
        ])
      )
        .filter((t) => t && t !== anthropicFinal.title)
        .slice(0, 4);

      const mergedHashtags = openaiDraft
        ? normalizeHashtags([...anthropicFinal.hashtags, ...openaiDraft.hashtags]).slice(0, 8)
        : anthropicFinal.hashtags;

      const mergedTags = openaiDraft
        ? normalizeTags([...anthropicFinal.tags, ...openaiDraft.tags]).slice(0, 14)
        : anthropicFinal.tags;

      const contributors = openaiDraft
        ? [openaiDraft.providerUsed, anthropicFinal.providerUsed]
        : [anthropicFinal.providerUsed];

      return {
        ...anthropicFinal,
        alternativeTitles: mergedAltTitles,
        hashtags: mergedHashtags,
        tags: mergedTags,
        providerUsed: openaiDraft
          ? `${openaiDraft.providerUsed} + ${anthropicFinal.providerUsed}`
          : anthropicFinal.providerUsed,
        providersUsed: contributors,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (err) {
      const anthropicErr = err instanceof Error ? err.message : 'Anthropic request failed';
      if (openaiDraft) {
        return {
          ...openaiDraft,
          warnings: [`Anthropic synthesis skipped (${anthropicErr})`],
        };
      }
      throw new Error(`${warnings[0] ? `${warnings[0]}; ` : ''}${anthropicErr}. Continue editing manually.`);
    }
  }

  const runners: Array<() => Promise<AiMetadataSuggestion>> = [];
  if (requested === 'anthropic') {
    runners.push(() => callAnthropicMetadata(basePrompt, anthropicKey));
  } else if (requested === 'openai') {
    runners.push(() => callOpenAIMetadata(basePrompt, openaiKey));
  } else {
    if (anthropicKey) runners.push(() => callAnthropicMetadata(basePrompt, anthropicKey));
    if (openaiKey) runners.push(() => callOpenAIMetadata(basePrompt, openaiKey));
  }

  let lastError: Error | null = null;
  for (const run of runners) {
    try {
      return await run();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('AI metadata request failed');
    }
  }

  throw lastError || new Error('AI metadata generation failed. Continue editing manually.');
}
