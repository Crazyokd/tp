export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TP_BASE_URL;
  if (raw === undefined) return DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`TP_BASE_URL is not an absolute http(s) URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`TP_BASE_URL is not an absolute http(s) URL: ${raw}`);
  }
  return raw;
}
