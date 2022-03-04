import type { NextPageContext, Redirect } from 'next';
import Router, { NextRouter, useRouter } from 'next/router';
import React, {
    ComponentType,
    ReactNode,
    Suspense,
    useEffect,
    useMemo,
    useState,
} from 'react';
import {
    loadQuery,
    PreloadedQuery,
    PreloadFetchPolicy,
    useQueryLoader,
} from 'react-relay/hooks';
import {
    Environment,
    GraphQLTaggedNode,
    OperationType,
    RelayFeatureFlags,
    Variables,
} from 'relay-runtime';
import { createWiredClientContext, createWiredServerContext } from './context';
import { WiredErrorBoundary, WiredErrorBoundaryProps } from './error_boundry';
import type { AnyPreloadedQuery } from './types';

// Enabling this feature flag to determine if a page should 404 on the server.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(RelayFeatureFlags as any).ENABLE_REQUIRED_DIRECTIVES = true;

export type OperationTypes = {
    [key: string]: OperationType;
}

export type WiredProps<
    P extends {} = {},
    Q extends OperationTypes = {}
    > = P
    & { CSN: boolean }
    & { [K in keyof Q]: PreloadedQuery<Q[K]> };

export type OrRedirect<T> = T | { redirect: Redirect };

export interface WiredOptions<Queries extends OperationTypes, ServerSideProps> {
    /** Fallback rendered when the page suspends. */
    fallback?: ReactNode;

    variablesFromContext?: (
        ctx: NextPageContext | NextRouter
    ) =>  { [K in keyof Queries]: Queries[K]['variables'] };

    /** Called when creating a Relay environment on the client. Should be idempotent. */
    createClientEnvironment: () => Environment;
    /** Props passed to the component when rendering on the client. */
    clientSideProps?: (
        ctx: NextPageContext
    ) => OrRedirect<Partial<ServerSideProps>>;
    /** Called when creating a Relay environment on the server. */
    createServerEnvironment: (
        ctx: NextPageContext,
        props: ServerSideProps
    ) => Promise<Environment>;
    /** Props passed to the component when rendering on the server. */
    serverSideProps?: (
        ctx: NextPageContext
    ) => Promise<OrRedirect<ServerSideProps>>;
    ErrorComponent?: WiredErrorBoundaryProps['ErrorComponent'];
    fetchPolicy?: PreloadFetchPolicy;
}

function defaultVariablesFromContext(
    ctx: NextPageContext | NextRouter
): Variables {
    return ctx.query;
}

/** Hook that records if query variables have changed. */
function useHaveQueryVariablesChanges(queryVariables: unknown) {
    const [haveVarsChanged, setVarsChanged] = useState<'pending' | boolean>(
        'pending'
    );

    useEffect(() => {
        setVarsChanged((current) => {
            if (current === 'pending') return false;
            return true;
        });
    }, [queryVariables]);

    return haveVarsChanged === 'pending' ? false : haveVarsChanged;
}

export function Wire<P extends {}, Queries extends OperationTypes, ServerSideProps>(
    Component: ComponentType<WiredProps<P, Queries>>,
    queries: { [K in keyof Queries]: GraphQLTaggedNode },
    opts: WiredOptions<Queries, ServerSideProps>
) {

    function WiredComponent(props: WiredProps<P, Queries>) {
        const router = useRouter();

        const hooks = Object.entries(queries).map(([key, query]) => {
            const [queryReference, loadQuery, disposeQuery] = useQueryLoader(
                query,
                props.preloadedQuery
            );

            return ({
                key,
                queryReference,
                loadQuery,
                disposeQuery
            });
        });

        const queryVariables = useMemo(() => {
            return opts.variablesFromContext
                ? opts.variablesFromContext(router)
                : Object.fromEntries(Object.keys(queries).map(key => [key, defaultVariablesFromContext(router)]));
        }, [router]);

        useEffect(() => {
            hooks.forEach(({key, loadQuery}) => loadQuery(queryVariables[key]));
            return () => hooks.forEach(({key, disposeQuery}) => disposeQuery());
        }, [hooks, queryVariables]);

        const haveQueryVarsChanged = useHaveQueryVariablesChanges(queryVariables);

        // If this component is being rendered from the client _or_ if it is a
        // subsequent render of the same component with different query variables
        // wrap with Suspense to catch page transitions. This is not done on
        // server-side renders because React 17 doesn't support SSR + Suspense, is
        // not done on the initial client render because it would caues React to
        // think there is a markup mismatch (even though there isn't), and isn't
        // done on mount to avoid unnecessary re-renders.
        if (props.CSN || haveQueryVarsChanged) {
            return (
                <WiredErrorBoundary ErrorComponent={opts.ErrorComponent}>
                    <Suspense fallback={opts.fallback ?? 'Loading...'}>
                        <Component
                            {...props}
                            {...hooks.map(({queryReference}) => queryReference)}
                        />
                    </Suspense>
                </WiredErrorBoundary>
            );
        } else {
            return (
                <Component
                    {...props}
                    {...hooks.map(({queryReference}) => queryReference)}
                />
            );
        }
    }

    WiredComponent.getInitialProps = wiredInitialProps(queries, opts);

    return WiredComponent;
}

function wiredInitialProps<Queries extends OperationTypes, ServerSideProps>(
    queries: { [K in keyof Queries]: GraphQLTaggedNode },
    opts: WiredOptions<Queries, ServerSideProps>
) {
    return async (ctx: NextPageContext) => {
        if (typeof window === 'undefined') {
            return getServerInitialProps(ctx, queries, opts);
        } else {
            return getClientInitialProps(ctx, queries, opts);
        }
    };
}

async function getServerInitialProps<Queries extends OperationTypes, ServerSideProps>(
    ctx: NextPageContext,
    queries: { [K in keyof Queries]: GraphQLTaggedNode },
    opts: WiredOptions<Queries, ServerSideProps>
) {
    const serverSideProps = opts.serverSideProps
        ? await opts.serverSideProps(ctx)
        : ({} as ServerSideProps);

    if ('redirect' in serverSideProps) {
        const { redirect } = serverSideProps;

        let statusCode = 302;
        if ('statusCode' in redirect) {
            statusCode = redirect.statusCode;
        } else if ('permanent' in redirect) {
            statusCode = redirect.permanent ? 308 : 307;
        }

        ctx
            .res!.writeHead(statusCode, {
            Location: redirect.destination,
        })
            .end();

        return { __wired__server__context: {} };
    }

    const env = await opts.createServerEnvironment(ctx, serverSideProps);
    const variables = opts.variablesFromContext
        ? opts.variablesFromContext(ctx)
        : Object.fromEntries(Object.keys(queries).map(key => [key, defaultVariablesFromContext(ctx)]));

    const preloadedQueries = Object.fromEntries(Object.entries(queries)
        .map(([key, query]) =>
            [key, loadQuery(
                env,
                query,
                variables[key]
            )]
        )
    );

    await Promise.allSettled(
        Object.entries(preloadedQueries)
            .map(([key, preloadedQuery]) => ensureQueryFlushed(preloadedQuery))
    );

    const context = createWiredServerContext({
        variables,
        queries,
        preloadedQueries,
    });

    return {
        ...serverSideProps,
        __wired__server__context: context,
    };
}

function getClientInitialProps<Queries extends OperationTypes, ClientSideProps>(
    ctx: NextPageContext,
    queries: { [K in keyof Queries]: GraphQLTaggedNode },
    opts: WiredOptions<Queries, ClientSideProps>
) {
    const clientSideProps = opts.clientSideProps
        ? opts.clientSideProps(ctx)
        : ({} as ClientSideProps);

    if ('redirect' in clientSideProps) {
        Router.push(clientSideProps.redirect.destination);
        return {};
    }

    const env = opts.createClientEnvironment();
    const variables = opts.variablesFromContext
        ? opts.variablesFromContext(ctx)
        : Object.fromEntries(Object.keys(queries).map(key => [key, defaultVariablesFromContext(ctx)]));

    const preloadedQueries = Object.fromEntries(Object.entries(queries)
        .map(([key, query]) =>
            [key, loadQuery(
                env,
                query,
                variables[key],
                { fetchPolicy: opts.fetchPolicy || 'store-and-network' }
            )]
        )
    );

    const context = createWiredClientContext(preloadedQueries);

    return {
        ...clientSideProps,
        __wired__client__context: context,
    };
}

function ensureQueryFlushed(query: AnyPreloadedQuery): Promise<void> {
    return new Promise((resolve, reject) => {
        if (query.source == null) {
            resolve();
        } else {
            query.source.subscribe({
                complete: resolve,
                error: reject,
            });
        }
    });
}
