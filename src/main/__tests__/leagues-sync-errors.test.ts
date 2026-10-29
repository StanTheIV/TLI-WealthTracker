/** Each leagues/backfill failure is logged with its description and never escapes, whatever was thrown. */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const h = vi.hoisted(() => ({
  fetch:    vi.fn(),
  getAll:   vi.fn(),
  backfill: vi.fn(),
  warn:     vi.fn(),
  error:    vi.fn(),
}));
vi.mock('electron', () => ({net: {fetch: h.fetch}}));
vi.mock('@/main/updater', () => ({REPO: 'owner/repo'}));
vi.mock('@/main/db', () => ({leaguesGetAll: h.getAll, leaguesApply: () => undefined, priceBackfillOnce: h.backfill}));
vi.mock('@/main/logger', () => ({log: {error: h.error, warn: h.warn, info: () => undefined, debug: () => undefined}}));

import {initLeaguesAndPriceHistory} from '@/main/leagues-sync';

beforeEach(() => vi.clearAllMocks());

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('initLeaguesAndPriceHistory failures', () => {
  it.each<[string, () => unknown, string]>([
    ['Error',                 () => Object.assign(new Error('boom'), {stack: 'Error: boom\n    at frame'}), 'Error: boom\n    at frame'],
    ['null-prototype object', () => Object.create(null), '[object Object]'],
    ['symbol',                () => Symbol('boom'),       'Symbol(boom)'],
  ])('a thrown %s in every step is logged and swallowed', async (_n, make, text) => {
    h.getAll.mockImplementation(() => { throw make(); });
    h.backfill.mockImplementation(() => { throw make(); });
    h.fetch.mockImplementation(async () => { throw make(); });

    expect(() => initLeaguesAndPriceHistory(() => undefined)).not.toThrow();
    await flush();

    expect(h.error.mock.calls).toEqual([
      ['price', `Bundled leagues merge failed: ${text}`],
      ['price', `Price backfill failed: ${text}`],
    ]);
    expect(h.warn.mock.calls).toEqual([['price', `Remote leagues sync failed: ${text}`]]);
  });
});
