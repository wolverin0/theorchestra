/**
 * Shared types for v3.0 MCP tool handlers.
 *
 * Each handler is a pure function: it receives validated args + the backend
 * client, and returns a v2.7-compatible `{ content, isError? }` envelope.
 * This matches the shape Claude Code's tool-call pipeline expects.
 */

import type { z } from 'zod';
import { BackendHttpError } from './client.js';

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface ToolHandler<I> {
  name: string;
  description: string;
  /** Zod raw shape (keys → ZodType), passed to McpServer.registerTool. */
  inputSchema: z.ZodRawShape;
  run: (input: I) => Promise<ToolResult>;
}

export function textResult(text: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return textResult(text, isError);
}

export function errorResult(message: string): ToolResult {
  return textResult(message, true);
}

/**
 * Wrap a backend client call, translating HTTP and network errors into a
 * user-facing ToolResult so the MCP caller always sees a friendly message.
 */
export async function callBackend<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; result: ToolResult }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    if (err instanceof BackendHttpError) {
      const detail =
        err.body && typeof err.body === 'object' && err.body !== null
          ? JSON.stringify(err.body)
          : String(err.body ?? '');
      return {
        ok: false,
        result: errorResult(`${label}: ${err.message}${detail ? ` — ${detail}` : ''}`),
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: errorResult(`${label}: ${msg}`) };
  }
}
