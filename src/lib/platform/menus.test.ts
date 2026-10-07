import { describe, expect, it } from 'vitest';
import { toolbarMenuContext } from './menus';

describe('toolbarMenuContext', () => {
  it('names the toolbar button the way each manifest version does', () => {
    expect(toolbarMenuContext(3)).toBe('action');
    expect(toolbarMenuContext(2)).toBe('browser_action');
  });
});
