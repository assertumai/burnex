import type { BackendEvent } from '../../backend/types.js';
import type { Usage } from '../journal/schema.js';

type Snapshot = Extract<BackendEvent, { kind: 'usage_snapshot' }>;
const counters = ['tokens_in', 'tokens_out', 'cache_read', 'cache_write'] as const;

/** Thread snapshots replace one attempt total; unknown baselines never become zero. */
export class UsageNormalizer {
  private sessionId: string | undefined;
  private baseline: Partial<Usage> | undefined;
  private latest: Partial<Usage> | undefined;
  uncertain = false;

  accept(event: Snapshot): Partial<Usage> | undefined {
    if (this.sessionId !== undefined && this.sessionId !== event.sessionId) {
      this.uncertain = true;
      return undefined;
    }
    this.sessionId = event.sessionId;
    if (counters.some((key) => event.usage[key] != null &&
      (!Number.isSafeInteger(event.usage[key]) || (event.usage[key] as number) < 0))) {
      this.uncertain = true;
      return undefined;
    }
    if (event.baseline === true) {
      if (this.baseline !== undefined) { this.uncertain = true; return undefined; }
      this.baseline = { ...event.usage };
      this.latest = { ...event.usage };
      return undefined;
    }
    if (this.baseline === undefined || counters.some((key) =>
      (event.usage[key] == null && this.latest?.[key] != null) ||
      (event.usage[key] != null && (this.baseline?.[key] == null ||
        event.usage[key]! < this.baseline[key]! ||
        (this.latest?.[key] != null && event.usage[key]! < this.latest[key]!))))) {
      this.uncertain = true;
      return undefined;
    }
    if (counters.every((key) => event.usage[key] === this.latest?.[key])) return undefined;
    const attempt: Partial<Record<typeof counters[number], number>> = {};
    for (const key of counters) {
      const value = event.usage[key];
      if (value != null) attempt[key] = value - (this.baseline[key] as number);
    }
    this.latest = { ...event.usage };
    return attempt;
  }

  state(): { sessionId?: string; baseline?: Partial<Usage>; latest?: Partial<Usage>; uncertain: boolean } {
    return { ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.baseline === undefined ? {} : { baseline: this.baseline }),
      ...(this.latest === undefined ? {} : { latest: this.latest }), uncertain: this.uncertain };
  }
}
