import { describe, expect, it } from 'vitest';
import type { QueuedEntry, QueuedState } from '../../lib/offline/queue';
import { planOpen } from './offline';

function queued(state: QueuedState): QueuedEntry {
  return {
    request: { url: 'https://e.test/a', title: 'A', notes: '', tags: [], fields: {} },
    picture: null,
    savedAt: 1,
    server: 'https://hrcek.example.org',
    state,
  };
}

describe('planOpen', () => {
  it('opens on the server’s entry when Hrček has it, noting a queued copy', () => {
    expect(planOpen('found', null)).toEqual({
      source: 'server',
      note: null,
      laterButton: false,
    });
    expect(planOpen('found', queued({ kind: 'held' }))).toEqual({
      source: 'server',
      note: 'alsoQueued',
      laterButton: false,
    });
    // Hrček got it after it was queued, before any sync looked.
    expect(planOpen('found', queued({ kind: 'waiting' })).note).toBe('alsoQueued');
  });

  it('opens on the queued copy when Hrček does not have it', () => {
    expect(planOpen('not-found', queued({ kind: 'waiting' }))).toEqual({
      source: 'queued',
      note: 'queued',
      laterButton: false,
    });
    expect(planOpen('not-found', queued({ kind: 'refused', message: 'no' })).note).toBe(
      'refused',
    );
    expect(planOpen('not-found', null)).toEqual({
      source: 'empty',
      note: null,
      laterButton: false,
    });
  });

  it('keeps for later when Hrček is unavailable, on the queued copy if there is one', () => {
    expect(planOpen('unavailable', null)).toEqual({
      source: 'empty',
      note: 'unavailable',
      laterButton: true,
    });
    expect(planOpen('unavailable', queued({ kind: 'waiting' }))).toEqual({
      source: 'queued',
      note: 'unavailable',
      laterButton: true,
    });
  });
});
