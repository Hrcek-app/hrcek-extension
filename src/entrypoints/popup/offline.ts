import type { QueuedEntry } from '../../lib/offline/queue';

export type LookupKind = 'found' | 'not-found' | 'unavailable';

/** Which note to show, as a name; main.ts says it in words. */
export type PopupNote = 'unavailable' | 'queued' | 'refused' | 'alsoQueued' | null;

export interface OpenPlan {
  /** What the form is filled from. */
  source: 'server' | 'queued' | 'empty';
  note: PopupNote;
  /** "Save for later" in place of Save. */
  laterButton: boolean;
}

/**
 * What the popup opens on. Hrček holding the address always wins: the
 * person sees what Save would replace, as ever. Otherwise a queued copy
 * is what they were last working on.
 */
export function planOpen(lookup: LookupKind, queued: QueuedEntry | null): OpenPlan {
  if (lookup === 'found') {
    return {
      source: 'server',
      note: queued === null ? null : 'alsoQueued',
      laterButton: false,
    };
  }
  const source = queued === null ? 'empty' : 'queued';
  if (lookup === 'unavailable') return { source, note: 'unavailable', laterButton: true };
  if (queued === null) return { source, note: null, laterButton: false };
  return {
    source,
    note: queued.state.kind === 'refused' ? 'refused' : 'queued',
    laterButton: false,
  };
}
