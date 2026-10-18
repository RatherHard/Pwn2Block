import { describe, expect, it } from 'vitest';
import { LIST_ROUTE, parseRoute, routeOfState, routePath, sameRoute } from '../src/viewmodel/route';

describe('history 路由的纯函数', () => {
  it('`/` 与未知地址都是题目列表', () => {
    for (const path of ['/', '', '/index.html', '/challenges', '/challenges/', '/foo/bar', '/challenges/a/b']) {
      expect(parseRoute(path), path).toEqual(LIST_ROUTE);
    }
  });

  it('`/challenges/<id>` 是题目页，末尾斜杠可省', () => {
    expect(parseRoute('/challenges/ret2win')).toEqual({ kind: 'challenge', id: 'ret2win' });
    expect(parseRoute('/challenges/ret2win/')).toEqual({ kind: 'challenge', id: 'ret2win' });
  });

  it('routePath 与 parseRoute 互逆，sameRoute 按地址比较', () => {
    const route = { kind: 'challenge', id: 'pushpop' } as const;
    expect(routePath(route)).toBe('/challenges/pushpop');
    expect(parseRoute(routePath(route))).toEqual(route);
    expect(routePath(LIST_ROUTE)).toBe('/');
    expect(sameRoute(route, { kind: 'challenge', id: 'pushpop' })).toBe(true);
    expect(sameRoute(route, LIST_ROUTE)).toBe(false);
  });

  it('routeOfState：列表页、题目页有地址；加载中、题目不存在、列表失败没有', () => {
    expect(routeOfState({ phase: 'choosing' })).toEqual(LIST_ROUTE);
    expect(routeOfState({ phase: 'choosing', challengeId: 'ret2win' })).toEqual(LIST_ROUTE);
    expect(routeOfState({ phase: 'opening', challengeId: 'ret2win' })).toEqual({ kind: 'challenge', id: 'ret2win' });
    expect(routeOfState({ phase: 'ready', challengeId: 'ret2win' })).toEqual({ kind: 'challenge', id: 'ret2win' });
    expect(routeOfState({ phase: 'unavailable', challengeId: 'ret2win' })).toEqual({ kind: 'challenge', id: 'ret2win' });
    expect(routeOfState({ phase: 'loading' })).toBeUndefined();
    expect(routeOfState({ phase: 'missing' })).toBeUndefined();
    expect(routeOfState({ phase: 'unavailable' })).toBeUndefined();
  });
});
