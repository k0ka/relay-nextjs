import type { ParsedUrlQuery } from 'querystring';
import { Variables } from 'relay-runtime';
import type { GraphQLTaggedNode, RecordSource } from 'relay-runtime';
import { AnyPreloadedQuery } from './types';

export interface WiredSerializedState {
  records: ReturnType<RecordSource['toJSON']>;
  queries: { [key: string]: GraphQLTaggedNode };
  variables: { [key: string]: Variables };
}

interface WiredWindow {
  __wired__?: WiredSerializedState;
}

export function getWiredSerializedState(): WiredSerializedState | undefined {
  return (window as WiredWindow)?.__wired__;
}
