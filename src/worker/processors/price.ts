import type {Processor, RawEvent} from './types';

export type PriceEvent = {type: 'price_update'; itemId: number; price: number};

// ---------------------------------------------------------------------------
// Regex patterns — ported from Python core/constants.py
// ---------------------------------------------------------------------------

// Matches SendMessage header; typ3 = category (may be item ID for simple searches)
const RE_SEND     = /Socket SendMessage STT----XchgSearchPrice----SynId = (\d+)/;
const RE_TYP3     = /\+typ3 \[(\d+)\]/;
// Matches the actual item ID in filtered (category) searches
const RE_REFER    = /\+refer \[(\d+)\]/;
// Matches RecvMessage header
const RE_RECV     = /Socket RecvMessage STT----XchgSearchPrice----SynId = (\d+)/;
// Matches individual listing prices: "+unitPrices+1 [20.0]" or "+2 [21.0]"
const RE_PRICE    = /\+(?:unitPrices\+)?\d+ \[([0-9.]+)\]/g;
// Currency marker that verifies this is a Flame Elementium (FE) price response
const FE_MARKER   = '+currency [100300]';
// End-of-message markers
const END_SEND    = 'Socket SendMessage End';
const END_RECV    = 'Socket RecvMessage End';
// Guard against unbounded buffering from malformed messages.
// Real recv blocks contain up to 100 price lines + headers/footers (~106 lines total).
const MAX_BUFFER  = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// PriceProcessor
// ---------------------------------------------------------------------------

/**
 * Stateful processor for multi-line XchgSearchPrice socket messages.
 *
 * The game log emits price search messages across multiple lines:
 *   1. A "SendMessage" block (market search request) containing the item ID
 *   2. A "RecvMessage" block (market search response) containing unit prices
 *
 * Both blocks are correlated via a SynId. Once a matching send+recv pair is
 * found, the median price is extracted and a `price_update` RawEvent is emitted.
 *
 * The processor claims all lines while buffering is active so continuation
 * lines (which don't contain 'XchgSearchPrice') are not lost in the dispatch loop.
 */
export class PriceProcessor implements Processor {
  readonly name = 'price';

  private _buffering = false;
  private _buffer:          string[]           = [];
  // Persists across messages — a send may arrive many lines before its recv
  private _pendingRequests: Map<string, number> = new Map();

  test(line: string): boolean {
    return this._buffering || line.includes('XchgSearchPrice');
  }

  process(line: string): RawEvent | null {
    if (!this._buffering) {
      this._buffering = true;
      this._buffer    = [line];
      return null;
    }

    this._buffer.push(line);

    // Safety valve: abort on oversized buffers (malformed message)
    if (this._buffer.length > MAX_BUFFER) {
      this._buffering = false;
      this._buffer    = [];
      return null;
    }

    const isEnd = line.includes(END_SEND) || line.includes(END_RECV);
    if (!isEnd) return null;

    const text   = this._buffer.join('\n');
    this._buffering = false;
    this._buffer    = [];
    return this._parseMessage(text);
  }

  private _parseMessage(text: string): RawEvent | null {
    // --- SendMessage (request): record item ID by SynId ---
    const sendMatch = RE_SEND.exec(text);
    if (sendMatch) {
      const synId       = sendMatch[1];
      const typ3Match   = RE_TYP3.exec(text);
      const referMatch  = RE_REFER.exec(text);

      if (typ3Match) {
        // +refer [0] means "no filter" in simple searches — only use +refer if non-zero
        const referValue = referMatch ? +referMatch[1] : 0;
        const itemId = referValue !== 0 ? referValue : +typ3Match[1];
        this._pendingRequests.set(synId, itemId);
      }
      return null; // Waiting for the corresponding RecvMessage
    }

    // --- RecvMessage (response): match to pending request and extract price ---
    const recvMatch = RE_RECV.exec(text);
    if (recvMatch) {
      const synId  = recvMatch[1];
      const itemId = this._pendingRequests.get(synId);
      if (itemId === undefined) return null;

      this._pendingRequests.delete(synId);

      if (!text.includes(FE_MARKER)) return null;

      const prices: number[] = [];
      let m: RegExpExecArray | null;
      RE_PRICE.lastIndex = 0; // reset global regex state
      while ((m = RE_PRICE.exec(text)) !== null) {
        prices.push(+m[1]);
      }
      if (prices.length === 0) return null;

      return {type: 'price_update', itemId, price: median(prices)};
    }

    return null;
  }
}
