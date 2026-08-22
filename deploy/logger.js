import appInsights from 'applicationinsights';

// Fields that must never reach logs (passwords, tokens, cookies, raw email bodies).
const REDACTED_KEYS = new Set(['password', 'token', 'reconnectToken', 'sessionToken', 'cookie', 'email']);

function sanitize(data) {
  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    clean[key] = REDACTED_KEYS.has(key) ? '[redacted]' : value;
  }
  return clean;
}

function severityFor(level) {
  const levels = appInsights.Contracts?.SeverityLevel;
  if (!levels) {
    return undefined;
  }
  if (level === 'error') return levels.Error;
  if (level === 'warn') return levels.Warning;
  return levels.Information;
}

function write(level, event, data) {
  const safeData = sanitize(data);
  const entry = { level, event, ts: new Date().toISOString(), ...safeData };
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  const client = appInsights.defaultClient;
  if (!client) {
    return;
  }

  if (safeData.error instanceof Error) {
    client.trackException({ exception: safeData.error, properties: { event, ...safeData, error: undefined } });
    return;
  }

  client.trackTrace({ message: event, severity: severityFor(level), properties: safeData });
}

export const logger = {
  info: (event, data = {}) => write('info', event, data),
  warn: (event, data = {}) => write('warn', event, data),
  error: (event, data = {}) => write('error', event, data),
  // Distinct App Insights "customEvents" stream for room/game lifecycle milestones.
  event: (name, data = {}) => {
    const safeData = sanitize(data);
    write('info', name, safeData);
    appInsights.defaultClient?.trackEvent({ name, properties: safeData });
  },
};
