import {describe, it, expect} from 'vitest';
import {createDispatcher} from '@/worker/create-dispatcher';
import {formatLogTimestamp, parseLogTimestamp, readLogText, type LogLine} from '@/replay/log-source';
import {createScrubber, REDACTED_RUN_ID} from '@/replay/scrub';
import {SYNTHETIC_FIXTURES} from '@/test/golden/synthetic';
import {GOLDEN_ITEMS} from '@/test/golden/items';
import {runPipeline} from '@/test/pipeline';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0, 0);
const ts = (ms: number) => formatLogTimestamp(T0 + ms);
const ZONE = (ms: number) =>
  `${ts(ms)}[612]TLLua: Display: [Game] PageApplyBase@ _UpdateGameEnd: LastSceneName = World'a' NextSceneName = World'b'`;
const NOISE = (ms: number) => `${ts(ms)}[1]LogTemp: Display: nothing`;
const S16 = (ms: number, run: string) =>
  `${ts(ms)}[1]TLLua: Display: [Game] [S16BGM] board Begin runId=${run} IsSettled=false Result=-1`;

const lines = (arr: string[]): LogLine[] => [...readLogText(arr.join('\n'))];

function scrubAll(arr: string[]) {
  const s = createScrubber();
  const out: Array<string | null> = lines(arr).map(l => s.scrub(l));
  const tail = s.finish();
  return {s, out, tail, text: [...out, tail].filter((x): x is string => x !== null)};
}

const eventTypes = (arr: string[]) => {
  const d = createDispatcher();
  return arr.flatMap(l => d.dispatch(l).map(e => e.type));
};

describe('formatLogTimestamp', () => {
  it.each([0, 1, 999, 1000, 59_999, 86_399_999])('round-trips ms offset %i', ms => {
    expect(parseLogTimestamp(`${formatLogTimestamp(T0 + ms)}x`)).toBe(T0 + ms);
  });

  it('round-trips a year boundary and a leap day', () => {
    for (const t of [Date.UTC(2025, 11, 31, 23, 59, 59, 999), Date.UTC(2028, 1, 29, 0, 0, 0, 1), Date.UTC(2026, 0, 1, 0, 0, 0, 0)]) {
      expect(parseLogTimestamp(formatLogTimestamp(t))).toBe(t);
    }
  });
});

describe('scrubber anchoring', () => {
  it('first line kept, last line kept: no anchors at all', () => {
    const {s, tail, out} = scrubAll([ZONE(0), NOISE(100), ZONE(200)]);
    expect(out).toEqual([ZONE(0), null, ZONE(200)]);
    expect(tail).toBeNull();
    expect(s.stats).toEqual({kept: 2, dropped: 1, unstamped: 0, anchors: 0});
  });

  it('first line dropped: replaced by its bare timestamp, exact', () => {
    const {out} = scrubAll([NOISE(5), ZONE(100)]);
    expect(out[0]).toBe(ts(5));
    expect(parseLogTimestamp(out[0]!)).toBe(T0 + 5);
  });

  it('a bare-timestamp anchor is matched by no processor', () => {
    expect(createDispatcher().dispatch(ts(5))).toEqual([]);
  });

  it('first kept, last dropped: only a closing anchor', () => {
    const {out, tail, s} = scrubAll([ZONE(0), NOISE(50), NOISE(300)]);
    expect(out).toEqual([ZONE(0), null, null]);
    expect(tail).toBe(ts(300));
    expect(s.stats.anchors).toBe(1);
  });

  it('single dropped line: one anchor, finish adds none', () => {
    const {text, s} = scrubAll([NOISE(7)]);
    expect(text).toEqual([ts(7)]);
    expect(s.stats.anchors).toBe(1);
  });

  it('single kept line: no anchors', () => {
    const {text, s} = scrubAll([ZONE(7)]);
    expect(text).toEqual([ZONE(7)]);
    expect(s.stats.anchors).toBe(0);
  });

  it('all dropped: exactly the first and last timestamps survive', () => {
    const {text, s} = scrubAll([NOISE(0), NOISE(10), NOISE(20), NOISE(333)]);
    expect(text).toEqual([ts(0), ts(333)]);
    expect(s.stats).toMatchObject({kept: 0, dropped: 4, anchors: 2});
  });

  it('two dropped lines: both anchored', () => {
    expect(scrubAll([NOISE(0), NOISE(9)]).text).toEqual([ts(0), ts(9)]);
  });

  it('empty slice: nothing, no finish anchor', () => {
    const {text} = scrubAll([]);
    expect(text).toEqual([]);
  });

  it('the scrubbed slice keeps the first/last log times of the raw slice', () => {
    const raw = [NOISE(3), ZONE(100), NOISE(250), NOISE(999)];
    const back = lines(scrubAll(raw).text);
    expect(back[0].ts).toBe(T0 + 3);
    expect(back.at(-1)!.ts).toBe(T0 + 999);
  });
});

describe('scrubber runId redaction', () => {
  it.each([
    ['lowercase guid', 'cbd0465f-c985-11f1-858f-000000000137'],
    ['UPPERCASE guid', 'CBD0465F-C985-11F1-858F-000000000137'],
    ['mixed case',     'cbd0465F-C985-11f1-858F-00000000013a'],
  ])('%s is redacted', (_n, guid) => {
    const {out} = scrubAll([S16(0, guid)]);
    expect(out[0]).toContain(REDACTED_RUN_ID);
    expect(out[0]).not.toContain(guid);
  });

  it('redacted line still yields the same event', () => {
    const {out} = scrubAll([S16(0, 'cbd0465f-c985-11f1-858f-000000000137')]);
    expect(eventTypes([out[0]!])).toEqual(eventTypes([S16(0, 'x')]));
  });

  it('every occurrence on a line is redacted', () => {
    const a = 'cbd0465f-c985-11f1-858f-000000000137';
    const line = S16(0, a).replace('IsSettled', `runId=${a} IsSettled`);
    const {out} = scrubAll([line]);
    expect(out[0]!.match(/runId=00000000-0000-0000-0000-000000000000/g)).toHaveLength(2);
  });

  it('a line with no timestamp prefix that is kept counts as unstamped, and is redacted', () => {
    const arr = [ZONE(0), `[S16BGM] board Begin runId=AAAA-bbbb IsSettled=false Result=-1`];
    const {s, out} = scrubAll(arr);
    expect(s.stats.unstamped).toBe(1);
    expect(out[1]).toContain(REDACTED_RUN_ID);
  });
});

describe('scrubber vs the stateful dispatcher', () => {
  it('stateless lines (level_type before zone, bag blocks) scrub to the same event stream', () => {
    const raw = lines(SYNTHETIC_FIXTURES['map-vorex'].split('\n')).map(l => l.text);
    const text = scrubAll(raw).text;
    expect(eventTypes(text)).toEqual(eventTypes(raw));
    // Every synthetic line there yields an event, so nothing may be dropped.
    expect(text.length).toBe(raw.length);
  });

  it('a lone first-line anchor never stands in for a continuation: dropped line stats add up', () => {
    const arr = [NOISE(0), ZONE(1), NOISE(2)];
    const {s} = scrubAll(arr);
    expect(s.stats.kept + s.stats.dropped).toBe(arr.length);
  });
});

/** A market price scrape (Send + Recv block): one price_update, on the Recv END
 *  line. Production routes it to the item table, never to the engine. */
const PRICE_ITEM = 6153;
const priceBlock = (ms: number): string[] => {
  const net = (dt: number, body: string) => `${ts(ms + dt)}[1]LogNet: ${body}`;
  return [
    net(0,   'Socket SendMessage STT----XchgSearchPrice----SynId = 77'),
    net(1,   `+typ3 [${PRICE_ITEM}]`),
    net(2,   'Socket SendMessage End'),
    net(500, 'Socket RecvMessage STT----XchgSearchPrice----SynId = 77'),
    net(501, '+unitPrices+1 [999.0]'),
    net(502, '+currency [100300]'),
    net(503, 'Socket RecvMessage End'),
  ];
};

/** The map-vorex scenario with a price block mid-map (31.0–31.503 s). */
function vorexWithPriceBlock(): {plain: string[]; withBlock: string[]; block: string[]} {
  const plain = SYNTHETIC_FIXTURES['map-vorex'].split('\n').filter(Boolean);
  const block = priceBlock(31_000);
  const at = plain.findIndex(l => (parseLogTimestamp(l) ?? 0) >= T0 + 35_000);
  return {plain, block, withBlock: [...plain.slice(0, at), ...block, ...plain.slice(at)]};
}

describe('scrubber on a price block', () => {
  const priceUpdates = (arr: string[]) => {
    const d = createDispatcher();
    return arr.flatMap(l => d.dispatch(l)).filter(e => e.type === 'price_update');
  };

  it('the raw slice yields one price_update', () => {
    expect(priceUpdates(priceBlock(0))).toEqual([{type: 'price_update', itemId: PRICE_ITEM, price: 999, listings: [999]}]);
  });

  it('the scrubbed slice keeps no line of the block, END included', () => {
    const block = priceBlock(0);
    const {out, s} = scrubAll([ZONE(-1), ...block, ZONE(1_000)]);
    expect(out).toEqual([ZONE(-1), ...block.map(() => null), ZONE(1_000)]);
    expect(s.stats).toEqual({kept: 2, dropped: block.length, unstamped: 0, anchors: 0});
  });

  it('a block mid-log scrubs to exactly the log without it', () => {
    const {plain, withBlock} = vorexWithPriceBlock();
    expect(scrubAll(withBlock).text).toEqual(scrubAll(plain).text);
  });

  it('a replay with the block gives the same engine events and saved session as one without', async () => {
    const {plain, withBlock} = vorexWithPriceBlock();
    expect(priceUpdates(withBlock)).toHaveLength(1);
    // One at a time: each replay installs the global fake clock.
    const a = await runPipeline(withBlock.join('\n'), {items: GOLDEN_ITEMS});
    const b = await runPipeline(plain.join('\n'), {items: GOLDEN_ITEMS});
    // Line numbers shift by the block's length; the events and their times must not.
    const stream = (r: typeof a) => r.events.map(({event, at}) => ({event, at}));
    expect(stream(a)).toEqual(stream(b));
    expect(a.sessions[0].session).not.toBeNull();
    expect(a.sessions).toEqual(b.sessions);
    // The scraped 999 never reaches the run: its snapshot is the item table's.
    expect(a.sessions[0].session!.priceSnapshot[String(PRICE_ITEM)]).toBe(GOLDEN_ITEMS[String(PRICE_ITEM)].price);
  });
});

