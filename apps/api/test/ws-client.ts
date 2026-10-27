import { WebSocket } from 'ws';

export interface Frame {
  type: string;
  ref?: string;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string };
}

/** A WebSocket client that records every frame so tests can wait for specific ones. */
export class Client {
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private closeWaiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.pred(f) ? (w.resolve(f), false) : true));
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.closeWaiters.forEach((r) => r());
    });
  }

  next(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const seen = this.frames.find(pred);
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (f: Frame) => {
          clearTimeout(t);
          this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f);
        },
      };
      // A waiter that timed out must not swallow a matching frame that arrives later.
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for frame; got ${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Resolves true if a matching frame arrives within the window (used to assert absence). */
  async receives(pred: (f: Frame) => boolean, windowMs = 400) {
    return this.next(pred, windowMs).then(
      () => true,
      () => false,
    );
  }

  send(f: object) {
    this.ws.send(JSON.stringify(f));
  }

  waitClosed(timeoutMs = 5000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(t);
        resolve(this.closed!);
      });
    });
  }

  close() {
    this.ws.close();
    return this.waitClosed();
  }
}

/** Opens a socket; resolves with the HTTP status if the upgrade is refused. */
export function rawConnect(host: string, query: string, headers: Record<string, string> = {}): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}/v1/realtime${query}`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => resolve(-1));
  });
}
