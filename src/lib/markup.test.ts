// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeAttribute, escapeText, setMarkup } from './markup';

describe('escapeText', () => {
  it('leaves text that can only be read as text', () => {
    expect(escapeText('<img src=x onerror=alert(1)> & co')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &amp; co',
    );
  });
});

describe('escapeAttribute', () => {
  it('cannot close the attribute it sits in', () => {
    expect(escapeAttribute('a" onclick="b')).toBe('a&quot; onclick=&quot;b');
  });
});

describe('setMarkup', () => {
  it('replaces what the host held', () => {
    const host = document.createElement('div');
    host.append(document.createElement('span'));
    setMarkup(host, '<p id="one">One</p><button>Two</button>');
    expect(host.children).toHaveLength(2);
    expect(host.querySelector('#one')!.textContent).toBe('One');
  });

  it('builds escaped values as text, never as elements', () => {
    const host = document.createElement('div');
    setMarkup(host, `<p>${escapeText('<b>bold</b>')}</p>`);
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toBe('<b>bold</b>');
  });

  it('runs no script it is handed', () => {
    const host = document.createElement('div');
    document.body.append(host);
    setMarkup(
      host,
      '<img src="x" onerror="window.__ran = true"><script>window.__ran = true</script>',
    );
    expect((window as { __ran?: boolean }).__ran).toBeUndefined();
  });

  it('empties the host for empty markup', () => {
    const host = document.createElement('div');
    host.append(document.createElement('span'));
    setMarkup(host, '');
    expect(host.childNodes).toHaveLength(0);
  });
});
