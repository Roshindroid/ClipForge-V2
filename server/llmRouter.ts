import type { AiMetadataSuggestion, AiProviderStatus } from '../src/types.ts';

export function getAiProviderStatus(): AiProviderStatus {
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
}

export interface GenerateYouTubeMetadataInput {
  provider?: 'auto' | 'anthropic' | 'openai';
  clipTitle: string;
  projectTitle?: string;
  durationSec?: number;
  existingHook?: string;
  existingDescription?: string;
}

function parseMetadataJson(raw: string, providerLabel: string): AiMetadataSuggestion {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as {
    title?: string;
    alternativeTitles?: unknown[];
    hookTagline?: string;
    description?: string;
    hashtags?: unknown[];
    tags?: unknown[];
  };

  const title = String(parsed.title || 'Unbelievable Stream Highlight #Shorts').trim().slice(0, 100);
  const alternativeTitles = Array.isArray(parsed.alternativeTitles)
    ? parsed.alternativeTitles.map((t) => String(t).trim().slice(0, 100)).filter(Boolean).slice(0, 4)
    : [];
  const hookTagline = String(parsed.hookTagline || 'Wait until the final second').trim().slice(0, 120);
  const description = String(parsed.description || '').trim().slice(0, 1200);
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags
        .map((h) => {
          const s = String(h).trim().replace(/\s+/g, '');
          if (!s) return '';
          return s.startsWith('#') ? s : `#${s}`;
        })
        .filter(Boolean)
        .slice(0, 10)
    : ['#shorts', '#highlights'];
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean).slice(0, 15)
    : ['shorts', 'stream clips', 'highlights'];

  return {
    title,
    alternativeTitles,
    hookTagline,
    description,
    hashtags,
    tags,
    providerUsed: providerLabel,
  };
}

async function callAnthropicMetadata(prompt: string, apiKey: string): Promise<AiMetadataSuggestion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const models = ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest'];
    let lastError = 'Anthropic request failed';

    for (const model of models) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          temperature: 0.6,
          system:
            'You are a YouTube Shorts metadata specialist. Respond strictly with valid JSON matching the requested schema and no markdown fences.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        lastError = `Anthropic API returned HTTP ${res.status}`;
        if (res.status === 404 && model !== models[models.length - 1]) {
          continue;
        }
        if (res.status === 429 || errBody.toLowerCase().includes('credit') || errBody.toLowerCase().includes('quota')) {
          throw new Error('Anthropic API rate limit or quota reached. Continue editing metadata manually.');
        }
        throw new Error(`${lastError}. Continue editing metadata manually.`);
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
  const timer = setTimeout(() => controller.abort(), 18000);
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
              'You are a YouTube Shorts metadata specialist. Respond strictly with valid JSON matching the requested schema.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 429 || errBody.toLowerCase().includes('quota') || errBody.toLowerCase().includes('insufficient_quota')) {
        throw new Error('OpenAI API quota or rate limit reached. Continue editing metadata manually.');
      }
      throw new Error(`OpenAI API returned HTTP ${res.status}. Continue editing metadata manually.`);
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
 * Generates YouTube Shorts titles, alternative titles, hook, description, hashtags, and searchable tags
 * strictly on the backend using configured Anthropic or OpenAI keys.
 */
export async function generateYouTubeMetadataWithAi(
  input: GenerateYouTubeMetadataInput
): Promise<AiMetadataSuggestion> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() || '';

  const requested = input.provider || 'auto';

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

  const prompt = [
    'Generate high-retention YouTube Shorts metadata for the following video clip.',
    `Clip title / notes: "${input.clipTitle}"`,
    input.projectTitle ? `Source video: "${input.projectTitle}"` : '',
    input.durationSec ? `Clip duration: ${input.durationSec} seconds` : '',
    input.existingHook ? `Existing hook context: "${input.existingHook}"` : '',
    input.existingDescription ? `Existing notes: "${input.existingDescription}"` : '',
    'Return valid JSON strictly matching this schema:',
    '{"title":"punchy primary YouTube Shorts title under 90 chars","alternativeTitles":["alt title 1","alt title 2","alt title 3"],"hookTagline":"1 short hook sentence","description":"engaging 2-3 sentence YouTube Shorts description","hashtags":["#shorts","#gaming","#clips","#highlights","#viral"],"tags":["comma-searchable tag 1","tag 2","tag 3","tag 4","tag 5","tag 6"]}',
  ]
    .filter(Boolean)
    .join('\n');

  const runners: Array<() => Promise<AiMetadataSuggestion>> = [];
  if (requested === 'anthropic') {
    runners.push(() => callAnthropicMetadata(prompt, anthropicKey));
  } else if (requested === 'openai') {
    runners.push(() => callOpenAIMetadata(prompt, openaiKey));
  } else {
    if (anthropicKey) runners.push(() => callAnthropicMetadata(prompt, anthropicKey));
    if (openaiKey) runners.push(() => callOpenAIMetadata(prompt, openaiKey));
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
