// Where a request came from.

/**
 * The client's address. Behind a trusted proxy it is the last address in X-Forwarded-For: the proxy adds the
 * address it saw at the end, and whatever comes before was written by the client itself (so taking the first
 * one would let anybody pick their own address and get round the limit on password attempts).
 */
export function clientAddress(forwardedFor, socketAddress, trustProxy) {
  const forwarded = trustProxy
    ? String(forwardedFor ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .pop()
    : null;
  return String(forwarded || socketAddress || '').replace(/^::ffff:/, '');
}
