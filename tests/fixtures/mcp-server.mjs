#!/usr/bin/env node
// Minimal stdio MCP server used by the TagCode test suite.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "tagcode-test-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the provided text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "echo") {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }] };
  }
  const text = String(request.params.arguments?.text ?? "");
  return { content: [{ type: "text", text: `echo:${text}` }] };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "file:///readme.md", name: "readme", mimeType: "text/markdown" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [{ uri: "file:///readme.md", mimeType: "text/markdown", text: "# Fixture resource" }],
}));

await server.connect(new StdioServerTransport());
