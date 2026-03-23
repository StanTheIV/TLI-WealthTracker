/**
 * Watcher — tails a log file and feeds complete lines to a callback.
 *
 * Uses fs.watchFile (250ms polling) with seek-from-last-position reads.
 * Handles file rotation/truncation and partial line buffering.
 */

import * as fs from 'fs';

export class Watcher {
  private _logPath = '';
  private _filePosition = 0;
  private _textBuffer = '';
  private _onLines: (lines: string[]) => void;
  private _onError: (message: string) => void;

  constructor(onLines: (lines: string[]) => void, onError: (message: string) => void) {
    this._onLines = onLines;
    this._onError = onError;
  }

  start(logPath: string): boolean {
    this._logPath = logPath;

    try {
      const stat = fs.statSync(logPath);
      this._filePosition = stat.size; // seek to end
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._onError(`Cannot open log file: ${msg}`);
      return false;
    }

    fs.watchFile(logPath, {interval: 250, persistent: true}, () => {
      this._readDelta();
    });

    return true;
  }

  stop(): void {
    if (this._logPath) {
      fs.unwatchFile(this._logPath);
      this._logPath = '';
      this._filePosition = 0;
      this._textBuffer = '';
    }
  }

  private _readDelta(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this._logPath);
    } catch {
      return;
    }

    // Detect file rotation/truncation
    if (stat.size < this._filePosition) {
      this._filePosition = stat.size;
      this._textBuffer = '';
      return;
    }

    if (stat.size === this._filePosition) return;

    const stream = fs.createReadStream(this._logPath, {
      start: this._filePosition,
      end: stat.size - 1,
      encoding: 'utf8',
    });

    const chunks: string[] = [];
    stream.on('data', (chunk) => chunks.push(chunk as string));
    stream.on('end', () => {
      this._filePosition = stat.size;
      this._textBuffer += chunks.join('');
      this._processBuffer();
    });
    stream.on('error', (err) => this._onError(err.message));
  }

  private _processBuffer(): void {
    const parts = this._textBuffer.split('\n');

    // Keep incomplete last line in buffer
    if (!this._textBuffer.endsWith('\n')) {
      this._textBuffer = parts[parts.length - 1];
      parts.pop();
    } else {
      this._textBuffer = '';
    }

    const lines = parts.filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      this._onLines(lines);
    }
  }
}
