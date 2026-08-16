import { describe, expect, test } from 'bun:test';
import { InFlight } from '../src/cache/in-flight.ts';
import { QueryCache } from '../src/cache/query-cache.ts';
import { stableHash } from '../src/utils/hash.ts';

describe('QueryCache', () => {
  test('set/get roundtrip', () => {
    const cache = new QueryCache();
    const key = cache.key('users', stableHash([{ role: 'admin' }]));
    cache.set(key, [1, 2, 3]);
    expect(cache.get(key)).toEqual([1, 2, 3]);
  });

  test('evicts beyond maxSize', () => {
    const cache = new QueryCache({ maxSize: 2 });
    const k1 = cache.key('a', '1');
    const k2 = cache.key('a', '2');
    const k3 = cache.key('a', '3');
    cache.set(k1, 1);
    cache.set(k2, 2);
    cache.set(k3, 3);
    expect(cache.get(k1)).toBeUndefined();
    expect(cache.get(k2)).toBe(2);
  });

  test('expires entries after TTL', async () => {
    const cache = new QueryCache({ ttlMs: 10 });
    const key = cache.key('a', '1');
    cache.set(key, 'v');
    expect(cache.get(key)).toBe('v');
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(key)).toBeUndefined();
  });

  test('invalidates by collection', () => {
    const cache = new QueryCache();
    const kUsers = cache.key('users', '1');
    const kOrders = cache.key('orders', '1');
    cache.set(kUsers, 'u');
    cache.set(kOrders, 'o');
    cache.invalidateByCollection('users');
    expect(cache.get(kUsers)).toBeUndefined();
    expect(cache.get(kOrders)).toBe('o');
  });

  test('clear wipes everything', () => {
    const cache = new QueryCache();
    cache.set(cache.key('a', '1'), 1);
    cache.set(cache.key('b', '1'), 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test('stats() reports hits/misses, evictions and lifecycle counters', () => {
    const cache = new QueryCache({ maxSize: 2 });
    expect(cache.stats()).toMatchObject({ size: 0, hits: 0, misses: 0, sets: 0, evictions: 0 });

    const k1 = cache.key('a', '1');
    const k2 = cache.key('a', '2');
    cache.set(k1, 1); // sets=1
    cache.get(k1); // hit
    cache.get(k2); // miss
    cache.set(k2, 2); // sets=2
    cache.set(cache.key('a', '3'), 3); // sets=3 → LRU evicts k1 (maxSize 2)
    expect(cache.stats()).toMatchObject({ size: 2, hits: 1, misses: 1, sets: 3, evictions: 1 });

    cache.invalidateByCollection('a'); // invalidateEvents=1 (keys existed)
    cache.invalidateByCollection('nope'); // no keys → not counted
    expect(cache.stats()).toMatchObject({ size: 0, invalidateEvents: 1, deletes: 0 });

    cache.clear();
    expect(cache.stats().clearEvents).toBe(1);
  });

  test('clone: true returns a fresh copy per read (mutation-isolated)', () => {
    const cache = new QueryCache({ clone: true });
    const key = cache.key('users', '1');
    cache.set(key, { _id: '1', tags: ['a'] });
    const first = cache.get(key) as { tags: string[] };
    first.tags.push('b'); // mutate the returned copy
    const second = cache.get(key) as { tags: string[] };
    expect(second.tags).toEqual(['a']); // stored entry untouched
  });

  test('clone: false shares the same reference by default', () => {
    const cache = new QueryCache();
    const key = cache.key('users', '1');
    cache.set(key, { tags: ['a'] });
    const value = cache.get(key) as { tags: string[] };
    value.tags.push('b');
    expect((cache.get(key) as { tags: string[] }).tags).toEqual(['a', 'b']);
  });
});

describe('InFlight dedup', () => {
  test('coalesces identical keys', async () => {
    const inflight = new InFlight();
    let runs = 0;
    const run = () =>
      inflight.run('same', async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 5));
        return 'ok';
      });
    const [a, b, c] = await Promise.all([run(), run(), run()]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    expect(c).toBe('ok');
    expect(runs).toBe(1);
    expect(inflight.size).toBe(0);
  });

  test('different keys run independently', async () => {
    const inflight = new InFlight();
    const keys: string[] = [];
    const run = (k: string) => inflight.run(k, async () => keys.push(k));
    await Promise.all([run('a'), run('b')]);
    expect(keys.sort()).toEqual(['a', 'b']);
  });
});
