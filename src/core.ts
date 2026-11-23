// Core logic with no dependency on the `vscode` module, so it can be unit tested with plain Node.
import { promises as fsp, statSync } from 'fs';

export interface FileSig {
  mtimeMs: number;
  size: number;
  ino: number;
}

export function sigFromStats(st: { mtimeMs: number; size: number; ino: number }): FileSig {
  return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
}

/** True if the two signatures differ. A change in inode catches rotation (rename + recreate). */
export function sigChanged(a: FileSig | undefined, b: FileSig | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a !== b;
  }
  return a.mtimeMs !== b.mtimeMs || a.size !== b.size || a.ino !== b.ino;
}

export interface ReadResult {
  data: Buffer;
  /** True when the file was larger than maxBytes and only its tail is returned. */
  truncated: boolean;
  /** Real size of the file on disk when it was read. */
  totalSize: number;
}

/**
 * Trim the start of a tail window so it begins at a line boundary
 * (or, if there is no newline, at a UTF-8 character boundary).
 */
export function dropPartialStart(data: Buffer): Buffer {
  const nl = data.indexOf(0x0a);
  if (nl >= 0 && nl < data.length - 1) {
    return data.subarray(nl + 1);
  }
  let i = 0;
  while (i < 3 && i < data.length && (data[i] & 0xc0) === 0x80) {
    i++;
  }
  return data.subarray(i);
}

/** Read the whole file, or only its last `maxBytes` bytes (maxBytes <= 0 means no limit). */
export async function readWindow(path: string, maxBytes: number): Promise<ReadResult> {
  const fh = await fsp.open(path, 'r');
  try {
    const st = await fh.stat();
    const limited = maxBytes > 0 && st.size > maxBytes;
    const length = limited ? maxBytes : st.size;
    const start = st.size - length;
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, start + got);
      if (bytesRead === 0) {
        break;
      }
      got += bytesRead;
    }
    let data: Buffer = buf.subarray(0, got);
    if (limited) {
      data = dropPartialStart(data);
    }
    return { data, truncated: limited, totalSize: st.size };
  } finally {
    await fh.close();
  }
}

/**
 * Polls a set of files by stat()-ing them on a timer. It never uses fs.watch / inotify,
 * so it keeps working when watchers fail or the inotify limit is exhausted.
 */
export class Poller {
  private entries = new Map<string, FileSig | undefined>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(
    private readonly intervalMs: () => number,
    private readonly onChange: (path: string) => void
  ) {}

  add(path: string): void {
    if (!this.entries.has(path)) {
      this.entries.set(path, this.statNow(path));
    }
  }

  remove(path: string): void {
    this.entries.delete(path);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** Record the file's current state as "seen" (use after our own write to avoid an echo event). */
  markSeen(path: string): void {
    if (this.entries.has(path)) {
      this.entries.set(path, this.statNow(path));
    }
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** One polling pass. Exposed for tests. */
  async tickOnce(): Promise<void> {
    for (const [path, prev] of [...this.entries]) {
      let sig: FileSig;
      try {
        sig = sigFromStats(await fsp.stat(path));
      } catch {
        // Missing or unreadable (for example mid-rotation): keep the old signature and
        // report the change when the file reappears.
        continue;
      }
      if (!this.entries.has(path)) {
        continue;
      }
      if (sigChanged(prev, sig)) {
        this.entries.set(path, sig);
        this.onChange(path);
      }
    }
  }

  private statNow(path: string): FileSig | undefined {
    try {
      return sigFromStats(statSync(path));
    } catch {
      return undefined;
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    const ms = Math.max(100, this.intervalMs());
    this.timer = setTimeout(async () => {
      try {
        await this.tickOnce();
      } catch {
        // Never let one bad pass kill the loop.
      }
      this.schedule();
    }, ms);
  }
}
