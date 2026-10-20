import { ToolError } from '@lkt/core';
import type { TransitQueries } from '@lkt/query';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { inputJsonSchema, outputJsonSchema } from './json-schema.js';
import { SERVER_INSTRUCTIONS, TOOLS, TOOL_NAMES, callTool, isToolName, type ToolCallInfo } from './tools.js';
import { scrubString } from './errors.js';

export const SERVER_NAME = 'lk-transit-mcp';
export const SERVER_VERSION = '0.1.0';
const RESOURCE_NOT_FOUND = -32002;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function json(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] };
}

/** Maps a failure while reading a resource to a JSON-RPC error with a client-safe message. */
function resourceError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof ToolError) {
    const notFound = err.code === 'unknown_route' || err.code === 'unknown_provider' || err.code === 'unknown_stop';
    return new McpError(notFound ? RESOURCE_NOT_FOUND : ErrorCode.InternalError, `${err.code}: ${scrubString(err.message)}`);
  }
  return new McpError(ErrorCode.InternalError, 'Internal error');
}

/**
 * Builds a fresh, stateless MCP server bound to `queries`. Tools are registered on the low-level `Server` (instead of
 * `McpServer.registerTool`) so invalid arguments become structured `{error:{code,message}}` results rather than the
 * SDK's free-text message, and so the input schemas can be emitted as JSON Schema 2020-12.
 */
export function createMcpServer(queries: TransitQueries, info: ToolCallInfo = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      title: TOOLS[name].title,
      description: TOOLS[name].description,
      inputSchema: inputJsonSchema(name) as { type: 'object' },
      outputSchema: outputJsonSchema(TOOLS[name].dataType) as { type: 'object' },
      annotations: { title: TOOLS[name].title, ...READ_ONLY },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!isToolName(name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
    return callTool(queries, name, req.params.arguments, info);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const providers = await queries.listProviders().catch(() => []);
    return {
      resources: [
        { uri: 'transit://providers', name: 'providers', title: 'Transit providers', description: 'Providers served by this server, with timezone and data licence.', mimeType: 'application/json' },
        { uri: 'transit://licenses', name: 'licenses', title: 'Data licences and attribution', description: 'Licence, licence status, provider authority and required attribution per provider. Cite the attribution when presenting provider data.', mimeType: 'application/json' },
        ...providers.map((p) => ({
          uri: `transit://providers/${p.provider}/status`,
          name: `${p.provider}-status`,
          title: `${p.name} feed status`,
          description: 'Freshness and health of the provider\'s timetable and live feeds.',
          mimeType: 'application/json',
        })),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: 'transit://providers/{provider}/status', name: 'provider-status', title: 'Provider feed status', mimeType: 'application/json' },
      { uriTemplate: 'transit://routes/{route_id}', name: 'route', title: 'Route detail', description: 'Route with directions and stop pattern; route_id from search_routes.', mimeType: 'application/json' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    try {
      if (uri === 'transit://providers') return json(uri, { data: await queries.listProviders() });
      if (uri === 'transit://licenses') {
        const providers = await queries.listProviders();
        return json(uri, { data: providers.map((p) => ({ provider: p.provider, name: p.name, ...p.license })) });
      }
      const status = /^transit:\/\/providers\/([^/]+)\/status$/.exec(uri);
      if (status?.[1]) return json(uri, await queries.getFeedStatus({ provider: decodeURIComponent(status[1]) }));
      const route = /^transit:\/\/routes\/([^/]+)$/.exec(uri);
      if (route?.[1]) return json(uri, await queries.getRoute({ route_id: decodeURIComponent(route[1]) }));
    } catch (err) {
      throw resourceError(err);
    }
    throw new McpError(RESOURCE_NOT_FOUND, 'Resource not found');
  });

  return server;
}

export interface McpHandlerOptions {
  queries: TransitQueries;
  maxBodyBytes: number;
  info: ToolCallInfo;
  onProtocolError?: (message: string) => void;
}

/**
 * Handles one `/mcp` POST: a fresh server + stateless Web-standard Streamable HTTP transport per request (no sessions,
 * JSON responses instead of SSE). Runs on Node and Cloudflare Workers.
 */
export async function handleMcpRequest(request: Request, opts: McpHandlerOptions): Promise<Response> {
  const server = createMcpServer(opts.queries, opts.info);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: opts.maxBodyBytes,
  });
  transport.onerror = (e) => opts.onProtocolError?.(e.message.slice(0, 120));
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}
