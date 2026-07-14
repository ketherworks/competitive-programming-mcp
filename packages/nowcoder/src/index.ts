#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNowCoderMcpServerFromEnvironment } from "./bootstrap.js";

const server = createNowCoderMcpServerFromEnvironment();
await server.connect(new StdioServerTransport());
