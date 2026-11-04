import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, toResult } from '../src/sources/http.js';

describe('cached', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reuses the value until the ttl expires', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const get = cached(1_000, fetcher);

    expect(await get()).toBe('a');
    vi.advanceTimersByTime(999);
    expect(await get()).toBe('a');
    vi.advanceTimersByTime(2);
    expect(await get()).toBe('b');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let resolve!: (value: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const get = cached(1_000, fetcher);

    const calls = [get(), get(), get()];
    resolve('shared');
    expect(await Promise.all(calls)).toEqual(['shared', 'shared', 'shared']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure instead of caching the error', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const get = cached(1_000, fetcher);

    await expect(get()).rejects.toThrow('boom');
    expect(await get()).toBe('ok');
  });
});

describe('toResult', () => {
  it('wraps success and failure without throwing', async () => {
    expect(await toResult('x', async () => 1)).toEqual({ ok: true, data: 1 });
    expect(await toResult('x', async () => Promise.reject(new Error('down')))).toEqual({
      ok: false,
      error: 'x: down',
    });
  });
});
