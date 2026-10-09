import type {Processor, RawEvent} from './types';
import {median} from '@/lib/percentiles';

export type PriceEvent = {type: 'price_update'; itemId: number; price: number; listings: number[]};

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
// Matches one listing price line: "+unitPrices+1 [20.0]" or "+2 [21.0]".
// Anchored to the line end so "+2+currency [100200]" / "+itemGoldId [x]" never match.
const RE_PRICE    = /\+(?:unitPrices\+)?\d+ \[([0-9.]+)\]\s*$/;
// Closes a price group: "| +currency [100300]" or "+2+currency [100200]"
const RE_CURRENCY = /\+currency \[(\d+)\]/;
// Flame Elementium (FE) currency id
const FE_CURRENCY = '100300';
// End-of-message markers
const END_SEND    = 'Socket SendMessage End';
const END_RECV    = 'Socket RecvMessage End';
// Guard against unbounded buffering from malformed messages.
// Real recv blocks contain up to 100 price lines + headers/footers (~106 lines total).
const MAX_BUFFER  = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

      // Responses can hold several price groups (one per currency). Price
      // lines accumulate until a +currency line closes the group.
      const groups = new Map<string, number[]>();
      let current: number[] = [];
      for (const line of text.split(/\r?\n/)) {
        const cur = RE_CURRENCY.exec(line);
        if (cur) {
          const existing = groups.get(cur[1]);
          groups.set(cur[1], existing ? existing.concat(current) : current);
          current = [];
          continue;
        }
        const pm = RE_PRICE.exec(line);
        if (pm) current.push(+pm[1]);
      }

      const listings = [...(groups.get(FE_CURRENCY) ?? [])].sort((a, b) => a - b);
      if (listings.length === 0) return null;

      return {type: 'price_update', itemId, price: median(listings), listings};
    }

    return null;
  }
}
