import { describe, expect, it } from 'vitest';
import { entryToForm, formToSaveRequest, parseTags, queuedToForm } from './form';
import type { EntryOut } from '../../lib/api/types';
import type { FieldOut } from '../../lib/api/types';

describe('parseTags', () => {
  it('splits on commas, trims, and drops empties', () => {
    expect(parseTags(' watches, diving ,,  ')).toEqual(['watches', 'diving']);
    expect(parseTags('')).toEqual([]);
  });
});

const DEFINITIONS: FieldOut[] = [
  { name: 'Price', kind: 'number', options: [] },
  { name: 'Priority', kind: 'choice', options: ['high', 'medium', 'low'] },
];

const ENTRY: EntryOut = {
  id: 1,
  url: 'https://example.com/watch',
  title: 'A watch',
  notes: '38mm',
  tags: ['diving', 'watches'],
  fields: { Price: '129' },
  image: null,
  created_at: '2026-09-13T12:28:12.937Z',
  updated_at: '2026-09-13T12:28:12.937Z',
};

describe('entryToForm', () => {
  it('fills the defined fields from the entry and leaves the rest empty', () => {
    const form = entryToForm(ENTRY, DEFINITIONS);
    expect(form.title).toBe('A watch');
    expect(form.fields.map((f) => [f.name, f.value])).toEqual([
      ['Price', '129'],
      ['Priority', ''],
    ]);
  });
});

describe('formToSaveRequest', () => {
  it('sends every rendered field so an emptied one is cleared', () => {
    const form = entryToForm(ENTRY, DEFINITIONS);
    form.fields[0]!.value = '';
    expect(formToSaveRequest(form).fields).toEqual({ Price: '', Priority: '' });
  });
});

describe('queuedToForm', () => {
  it('fills the form from a queued copy', () => {
    const form = queuedToForm(
      {
        request: {
          url: 'https://e.test/a',
          title: 'A',
          notes: 'n',
          tags: ['x', 'y'],
          fields: { Price: '3' },
        },
        picture: null,
        savedAt: 1,
        server: 'https://hrcek.example.org',
        state: { kind: 'waiting' },
      },
      null,
    );
    expect(form.url).toBe('https://e.test/a');
    expect(form.title).toBe('A');
    expect(form.notes).toBe('n');
    expect(form.tags).toBe('x, y');
    expect(form.fields.map((f) => [f.name, f.value])).toEqual([['Price', '3']]);
  });
});
