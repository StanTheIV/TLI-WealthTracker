import {it, expect, vi} from 'vitest';
import {installProcessErrorHandlers} from '@/main/process-errors';

// Slim spec 5.1d.4: the FIRST error per run also shows the box; a throwing logPath() falls back to no path.
it('a throwing logPath still shows the first error box', () => {
  const l = new Map<string, (e: unknown) => void>();
  const showErrorBox = vi.fn();
  installProcessErrorHandlers({
    on: (ev, fn) => { l.set(ev, fn); }, log: {error: vi.fn()}, showErrorBox,
    logPath: () => { throw new Error('no path'); },
  });
  l.get('uncaughtException')!(new Error('boom'));
  expect(showErrorBox).toHaveBeenCalledTimes(1);
});
