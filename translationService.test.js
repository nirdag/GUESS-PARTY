import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalEnv = { ...process.env };

function setTranslatorEnv() {
  process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://example.cognitiveservices.azure.com';
  process.env.AZURE_TRANSLATOR_KEY = 'test-key';
  process.env.AZURE_TRANSLATOR_REGION = 'westus2';
}

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('translationService.js: translateText', () => {
  it('returns an error when Translator env vars are not configured', async () => {
    delete process.env.AZURE_TRANSLATOR_ENDPOINT;
    delete process.env.AZURE_TRANSLATOR_KEY;
    delete process.env.AZURE_TRANSLATOR_REGION;
    const { translateText } = await import('./translationService.js');

    const result = await translateText('Hello there?', 'en', 'he');
    expect(result.error).toBeDefined();
  });

  it('returns translated text on a successful API response', async () => {
    setTranslatorEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ translations: [{ text: '?שלום' }] }],
    }));
    const { translateText } = await import('./translationService.js');

    const result = await translateText('Hello?', 'en', 'he');
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('?שלום');
  });

  it('returns an error when the API responds with a non-ok status', async () => {
    setTranslatorEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const { translateText } = await import('./translationService.js');

    const result = await translateText('Hello?', 'en', 'he');
    expect(result.error).toBeDefined();
  });

  it('returns an error when the network request throws', async () => {
    setTranslatorEnv();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { translateText } = await import('./translationService.js');

    const result = await translateText('Hello?', 'en', 'he');
    expect(result.error).toBeDefined();
  });
});
