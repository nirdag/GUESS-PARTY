// Translates admin gallery questions via Azure AI Translator when configured; otherwise no-ops (caller shows a warning).
const languageNames = { en: 'English', he: 'Hebrew' };

async function translateText(text, sourceLanguage, targetLanguage) {
  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;

  if (!endpoint || !key || !region) {
    return { error: 'Translation is not configured.' };
  }

  const url = `${endpoint.replace(/\/$/, '')}/translate?api-version=3.0&from=${sourceLanguage}&to=${targetLanguage}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ text }]),
    });

    if (!response.ok) {
      return { error: `Translation service error (${response.status}).` };
    }

    const payload = await response.json();
    const translated = payload?.[0]?.translations?.[0]?.text;
    if (!translated) {
      return { error: 'Translation service returned no result.' };
    }

    return { text: translated };
  } catch {
    return { error: 'Unable to reach the translation service.' };
  }
}

export { translateText, languageNames };
