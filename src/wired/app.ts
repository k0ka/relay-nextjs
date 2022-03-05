import type { AppProps } from 'next/app';
import type { Environment } from 'react-relay/hooks';
import { loadQuery } from 'react-relay/hooks';
import { IEnvironment } from 'relay-runtime';
import type { WiredProps } from './component';
import { getWiredClientContext, getWiredServerContext } from './context';
import { getWiredSerializedState } from './serialized_state';
import type { AnyPreloadedQuery } from './types';

export function getWiredProps(
  pageProps: AppProps['pageProps'],
  initialPreloadedQuery: { [key: string]: AnyPreloadedQuery } | null
): [Partial<WiredProps>, IEnvironment?] {
  const serverContext = getWiredServerContext(
    pageProps.__wired__server__context
  );

  const clientContext = getWiredClientContext(
    pageProps.__wired__client__context
  );

  const CSN = clientContext != null;
  const preloadedQueries = clientContext?.preloadedQueries
      ?? serverContext?.preloadedQueries
      ?? initialPreloadedQuery!;

  return [{ CSN, ...preloadedQueries }, serverContext?.environment];
}

export function getInitialPreloadedQuery(opts: {
  createClientEnvironment: () => Environment;
}): { [key: string]: AnyPreloadedQuery } | null {
  if (typeof window === 'undefined') return null;
  const serializedState = getWiredSerializedState();
  if (serializedState == null || serializedState.queries == null) return null;

  const env = opts.createClientEnvironment()!;

  return Object.fromEntries(
    Object.entries(serializedState.queries).map(([key, query]) => [
      key,
      loadQuery(env, query, serializedState.variables[key], {
        fetchPolicy: 'store-or-network',
      }),
    ])
  );
}
