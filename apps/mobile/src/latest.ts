/**
 * Only the most recent of several overlapping requests may apply its result.
 *
 * Home fetches lots once for a quick position and again for the fresh one,
 * and a focus, a return to the foreground or a Refresh can start another
 * round while one is in flight. Responses arrive in any order: without this,
 * a slow response for an OLD position lands last and replaces the list
 * computed for the new one.
 */
export interface Latest {
  /** Start a request; the ticket is current until the next take(). */
  take: () => number;
  isCurrent: (ticket: number) => boolean;
}

export function latestOnly(): Latest {
  let current = 0;
  return {
    take: () => {
      current += 1;
      return current;
    },
    isCurrent: (ticket) => ticket === current,
  };
}
