import { GoogleGenAI } from '@google/genai';
import { checkOllama, getOllamaHost } from './capabilities.ts';

export interface CandidateClipInput {
  startSec: number;
  endSec: number;
  audioPeakDb: number;
  audioSpikeScore: number;
  transcriptSnippet: string;
}

export interface ScoredClipOutput {
  llmScore: number;
  title: string;
  hookTagline: string;
  description: string;
  hashtags: string[];
  reason: string;
  scoredBy: string;
}

async function callOpenAICompatible(params: {
  endpointUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...params.extraHeaders,
    };
    if (params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }

    const res = await fetch(params.endpointUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: params.model,
        temperature: 0.35,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Respond strictly with valid JSON matching the requested schema.',
          },
          { role: 'user', content: params.prompt },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty completion content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function scoreMomentsWithRouter(
  projectTitle: string,
  candidates: CandidateClipInput[]
): Promise<ScoredClipOutput[] | null> {
  if (candidates.length === 0) return null;

  const geminiKey = process.env.GEMINI_API_KEY?.trim() || '';
  const groqKey = process.env.GROQ_API_KEY?.trim() || '';
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim() || '';
  const ollamaInfo = await checkOllama().catch(() => ({ available: false, host: '', models: [] }));

  const prompt = [
    'You are picking the best short-form vertical moments for YouTube Shorts.',
    `Source video title: "${projectTitle}".`,
    `Evaluate these ${candidates.length} candidate segments (with transcript & audio energy) and return JSON strictly matching: {"clips":[{"llmScore":0.0-1.0,"title":"short punchy title","hookTagline":"1-line hook tagline","description":"2-sentence YouTube Shorts description","hashtags":["#shorts","#highlights"],"reason":"brief reason"}]}`,
    `Candidates: ${JSON.stringify(candidates)}`,
  ].join('\n');

  const attempts: Array<{
    label: string;
    run: () => Promise<string>;
  }> = [];

  if (geminiKey) {
    attempts.push({
      label: 'Gemini (gemini-2.5-flash)',
      run: async () => {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        return response.text || '';
      },
    });
  }

  if (groqKey) {
    attempts.push({
      label: 'Groq (llama-3.3-70b-versatile)',
      run: () =>
        callOpenAICompatible({
          endpointUrl: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: groqKey,
          model: 'llama-3.3-70b-versatile',
          prompt,
        }),
    });
  }

  if (openrouterKey) {
    attempts.push({
      label: 'OpenRouter (llama-3.3-70b)',
      run: () =>
        callOpenAICompatible({
          endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
          apiKey: openrouterKey,
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          prompt,
          extraHeaders: { 'X-Title': 'ClipForge' },
        }),
    });
  }

  if (ollamaInfo.available && ollamaInfo.models.length > 0) {
    const model = process.env.OLLAMA_MODEL?.trim() || ollamaInfo.models[0];
    attempts.push({
      label: `Ollama (${model})`,
      run: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 14000);
        try {
          const res = await fetch(`${getOllamaHost()}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              prompt,
              stream: false,
              format: 'json',
            }),
          });
          if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
          const payload = (await res.json()) as { response?: string };
          return payload.response || '';
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }

  for (const attempt of attempts) {
    try {
      const rawText = await attempt.run();
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/```$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned) as {
        clips?: Array<{
          llmScore?: number;
          title?: string;
          hookTagline?: string;
          description?: string;
          hashtags?: string[];
          reason?: string;
        }>;
      };

      if (!Array.isArray(parsed.clips) || parsed.clips.length !== candidates.length) {
        continue;
      }

      return parsed.clips.map((c, idx) => ({
        llmScore: Math.min(1, Math.max(0.2, Number(c.llmScore || 0.75))),
        title: String(c.title || `Peak Moment #${idx + 1}`).slice(0, 90),
        hookTagline: String(c.hookTagline || 'Wait until the final second').slice(0, 110),
        description: String(
          c.description ||
            `Clipped from ${projectTitle}. Watch the key audio spike and reaction moment.`
        ).slice(0, 400),
        hashtags: Array.isArray(c.hashtags)
          ? c.hashtags.slice(0, 6).map((h) => (h.startsWith('#') ? h : `#${h}`))
          : ['#shorts', '#clips', '#highlights'],
        reason: String(c.reason || `${attempt.label} viral highlight match`).slice(0, 140),
        scoredBy: attempt.label,
      }));
    } catch {
      // Try next configured AI provider silently
    }
  }

  return null;
}
