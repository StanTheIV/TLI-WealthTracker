import {describe, it, expect, vi, beforeEach} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import {Engine} from '@/main/engine/engine';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {ZoneHandler} from '@/main/engine/handlers/zone';
import {ItemHandler} from '@/main/engine/handlers/item';
import type {EngineEvent} from '@/main/engine/types';

interface Entry {pageId: number; slotId: number; itemId: number; quantity: number}

function loadEntries(path: string): Entry[] {
  const txt = readFileSync(path, 'utf8').trim();
  const lines = txt.split(/\r?\n/);
  return lines.map(line => {
    const m = /pageId: (\d+), slotId: (\d+), itemId: (\d+), quantity: (\d+)/.exec(line);
    if (!m) throw new Error(`bad line: ${line}`);
    return {pageId: +m[1], slotId: +m[2], itemId: +m[3], quantity: +m[4]};
  });
}

beforeEach(() => { vi.useFakeTimers(); });

describe('real-resort: replays the user-reported bursts', () => {
  it('zero-delta resort produces zero new_item / drop events', () => {
    const pre  = loadEntries(join(__dirname, 'fixtures/real-pre.txt'));
    const post = loadEntries(join(__dirname, 'fixtures/real-post.txt'));

    const events: EngineEvent[] = [];
    const engine = new Engine((e) => events.push(e))
      .register(new BagInitHandler())
      .register(new ZoneHandler())
      .register(new ItemHandler());

    engine.start();
    // Init phase: feed pre-burst as initial bag dump
    for (const e of pre) {
      engine.onRawEvent({type: 'bag_init', ...e});
    }
    vi.advanceTimersByTime(600); // init debounce

    const eventsAfterInit = events.length;

    // Tracking phase: feed post-burst as resort
    for (const e of post) {
      engine.onRawEvent({type: 'bag_init', ...e});
    }
    vi.advanceTimersByTime(400);

    const newEvents = events.slice(eventsAfterInit);
    const newItemCount = newEvents.filter(e => e.type === 'new_item').length;
    const dropCount    = newEvents.filter(e => e.type === 'drop').length;

    console.log(`Events fired by the resort: ${newEvents.length}`);
    console.log(`new_item: ${newItemCount}, drop: ${dropCount}`);
    console.log('event types:', newEvents.map(e => e.type));

    expect(newItemCount).toBe(0);
    expect(dropCount).toBe(0);
  });
});
