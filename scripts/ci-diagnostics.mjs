/** Keep CI failures readable through check annotations as well as log storage. */
export function workflowError(title, details) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const redacted = String(details)
    .replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]')
    .replace(/((?:launchToken|authorization|cookie|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
  // GitHub truncates annotation messages at 4 KiB. Keep each failure readable.
  const escaped = Buffer.from(redacted).subarray(0, 3500).toString('utf8')
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  process.stderr.write(`::error title=${title}::${escaped}\n`);
}
