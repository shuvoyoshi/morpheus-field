/** Take lineage: walk the parent chain of a take into an ordered list. */
import type { Take } from './api';

/**
 * The chain a take was made from, oldest first (the root source first, the
 * given take last). Walks `parent_take_id` upward; cycle-safe and stops at a
 * parent that is not in the list (an external input, or a deleted take).
 */
export function lineage(takes: Take[], id: number): Take[] {
  const byId = new Map(takes.map((t) => [t.id, t]));
  const chain: Take[] = [];
  const seen = new Set<number>();
  let cur: Take | undefined = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent_take_id != null ? byId.get(cur.parent_take_id) : undefined;
  }
  return chain;
}

/** Whether a take has anything to show in a lineage chain (a parent, or a child pointing at it). */
export function hasLineage(takes: Take[], id: number): boolean {
  const t = takes.find((x) => x.id === id);
  if (!t) return false;
  if (t.parent_take_id != null) return true;
  return takes.some((x) => x.parent_take_id === id);
}
