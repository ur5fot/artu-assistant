import type { ToolResult } from '@r2/shared';
import { resolveRoot } from './paths.js';
import { readFile, writeFile, listFiles, deleteFile, moveFile } from './operations.js';

const tools = [
  {
    name: 'file_read',
    description: 'Read the contents of a text file. Returns the file content as a string. Only works within the allowed directory.',
    permissionLevel: 'auto' as const,
    provider: 'all' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the working directory' },
      },
      required: ['path'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (typeof params.path !== 'string' || !params.path) {
        return { success: false, error: 'Missing or invalid "path" parameter' };
      }
      return readFile(resolveRoot(), params.path);
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates intermediate directories as needed.',
    permissionLevel: 'confirm' as const,
    provider: 'all' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the working directory' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (typeof params.path !== 'string' || !params.path) {
        return { success: false, error: 'Missing or invalid "path" parameter' };
      }
      if (typeof params.content !== 'string') {
        return { success: false, error: 'Missing or invalid "content" parameter' };
      }
      return writeFile(resolveRoot(), params.path, params.content);
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories. Returns an array of entries with name and type (file/directory). Use recursive: true to include nested contents (max 1000 entries).',
    permissionLevel: 'auto' as const,
    provider: 'all' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: ".")' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
      required: [] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      const dirPath = typeof params.path === 'string' && params.path ? params.path : '.';
      const recursive = params.recursive === true;
      return listFiles(resolveRoot(), dirPath, recursive);
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a file. Cannot delete directories.',
    permissionLevel: 'confirm' as const,
    provider: 'all' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete' },
      },
      required: ['path'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (typeof params.path !== 'string' || !params.path) {
        return { success: false, error: 'Missing or invalid "path" parameter' };
      }
      return deleteFile(resolveRoot(), params.path);
    },
  },
  {
    name: 'file_move',
    description: 'Move or rename a file. Creates intermediate directories for the destination if needed.',
    permissionLevel: 'confirm' as const,
    provider: 'all' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Current relative path of the file' },
        destination: { type: 'string', description: 'New relative path for the file' },
      },
      required: ['source', 'destination'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (typeof params.source !== 'string' || !params.source) {
        return { success: false, error: 'Missing or invalid "source" parameter' };
      }
      if (typeof params.destination !== 'string' || !params.destination) {
        return { success: false, error: 'Missing or invalid "destination" parameter' };
      }
      return moveFile(resolveRoot(), params.source, params.destination);
    },
  },
];

export default tools;
