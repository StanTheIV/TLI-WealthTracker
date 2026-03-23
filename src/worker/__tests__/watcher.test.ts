import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Watcher} from '@/worker/watcher';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
let logFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
  logFile = path.join(tmpDir, 'test.log');
  fs.writeFileSync(logFile, ''); // create empty
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Poll until predicate is true or timeout expires. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await waitMs(intervalMs);
  }
}

describe('Watcher', () => {
  it('seeks to end on start — ignores existing content', async () => {
    fs.writeFileSync(logFile, 'old line 1\nold line 2\n');

    const received: string[][] = [];
    const watcher = new Watcher((lines) => received.push(lines), () => {});
    const ok = watcher.start(logFile);
    expect(ok).toBe(true);

    // Append new content
    fs.appendFileSync(logFile, 'new line\n');
    await waitUntil(() => received.flat().length >= 1);

    watcher.stop();

    // Should only see the new line, not old ones
    const allLines = received.flat();
    expect(allLines).toEqual(['new line']);
  });

  it('reports error for non-existent file', () => {
    const errors: string[] = [];
    const watcher = new Watcher(() => {}, (msg) => errors.push(msg));
    const ok = watcher.start('/nonexistent/path/file.log');
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Cannot open log file');
  });

  it('handles partial lines correctly', async () => {
    const received: string[][] = [];
    const watcher = new Watcher((lines) => received.push(lines), () => {});
    watcher.start(logFile);

    // Write a line without trailing newline — buffered, not emitted yet
    fs.appendFileSync(logFile, 'partial');
    await waitMs(400); // allow poll to fire and buffer the partial

    // Complete the line
    fs.appendFileSync(logFile, ' complete\n');
    await waitUntil(() => received.flat().length >= 1);

    watcher.stop();

    const allLines = received.flat();
    expect(allLines).toEqual(['partial complete']);
  });

  it('delivers multiple lines in one batch', async () => {
    const received: string[][] = [];
    const watcher = new Watcher((lines) => received.push(lines), () => {});
    watcher.start(logFile);

    fs.appendFileSync(logFile, 'line1\nline2\nline3\n');
    await waitUntil(() => received.flat().length >= 3);

    watcher.stop();

    const allLines = received.flat();
    expect(allLines).toEqual(['line1', 'line2', 'line3']);
  });

  it('skips empty lines', async () => {
    const received: string[][] = [];
    const watcher = new Watcher((lines) => received.push(lines), () => {});
    watcher.start(logFile);

    fs.appendFileSync(logFile, 'line1\n\n\nline2\n');
    await waitUntil(() => received.flat().length >= 2);

    watcher.stop();

    const allLines = received.flat();
    expect(allLines).toEqual(['line1', 'line2']);
  });

  it('handles file truncation (rotation)', async () => {
    const received: string[][] = [];
    const watcher = new Watcher((lines) => received.push(lines), () => {});
    watcher.start(logFile);

    // Write some content
    fs.appendFileSync(logFile, 'before rotation\n');
    await waitUntil(() => received.flat().includes('before rotation'));

    // Simulate rotation: truncate and write new content
    fs.writeFileSync(logFile, '');
    await waitMs(400); // allow poll to detect truncation

    fs.appendFileSync(logFile, 'after rotation\n');
    await waitUntil(() => received.flat().includes('after rotation'));

    watcher.stop();

    const allLines = received.flat();
    expect(allLines).toContain('before rotation');
    expect(allLines).toContain('after rotation');
  });
});
