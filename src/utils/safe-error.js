const REDACTED = '[redacted]';
const MAX_LENGTH = 300;

export function describeError(error) {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error === 'string' ? error
    : typeof error?.message === 'string' && error.message ? error.message : 'Unknown error';

  const sanitized = `${name}: ${message}`
    // Some libraries embed a header dump or stack frames in the message itself.
    .replace(/\b(?:request[ _-]+)?headers\s*[:=][\s\S]*/i, REDACTED)
    .replace(/\r?\n\s*at\s+[^\r\n]+[\s\S]*/, '')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|cf-access-[\w-]+|x-[\w-]+)\s*:\s*[^\r\n]*/gi, REDACTED)
    .replace(/\bbearer\s+[^\s"',;<>]+/gi, REDACTED)
    // Redact full URLs, including paths, userinfo and queries.
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|(?<![:\w])\/\/)[^\s"'<>]+/gi, REDACTED)
    .replace(/\/[^\s"'<>?]*\?[^\s"'<>]+/g, REDACTED)
    .replace(/\b(?:token|api[_-]?key|client[_-]?secret|password)\s*=\s*[^\s"'<>;,]+/gi, REDACTED)
    .replace(/[^\s"'<>:@]+:[^\s"'<>@]+@[^\s"'<>]+/g, REDACTED)
    .replace(/[\w.!#$%&'*+/=?^_\x60{|}~-]+@[\w.-]+/g, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_|secret_|ntn_|cfast_|sk-)[a-z\d_-]+/gi, REDACTED)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, REDACTED)
    .replace(/(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?:%[\w.-]+)?/gi, REDACTED)
    .replace(/[a-z\d+/_-]{32,}={0,2}/gi, REDACTED)
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
    .trim();

  return Array.from(sanitized).slice(0, MAX_LENGTH).join('');
}
