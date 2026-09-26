/**
 * The client's address, as Express computes req.ip with `trust proxy` set to
 * a number of hops, for the places Express does not reach: the Socket.io
 * handshake, which sees only the TCP peer (behind Caddy, always Caddy).
 *
 * The rule: start at the socket's peer and walk back through exactly `hops`
 * X-Forwarded-For entries, the ones the proxies in front appended; anything
 * earlier in the header was written by the client and is not believed.
 * test/rate-limit.test.ts checks this against Express's own req.ip.
 */
export function clientAddress(
  remote: string,
  forwardedFor: string | string[] | undefined,
  hops: number,
): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const appended = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .reverse();
  const chain = [remote, ...appended];
  return chain[Math.min(hops, chain.length - 1)] ?? remote;
}
