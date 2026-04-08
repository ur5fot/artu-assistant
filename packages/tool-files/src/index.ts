import type { ToolResult } from '@r2/shared';
import { resolveRoot } from './paths.js';
import { readFile, writeFile, listFiles, deleteFile, moveFile } from './operations.js';

const tools = [
  {
    name: 'file_read',
    description: 'Read the contents of a text file. Returns the file content as a string. Only works within the allowed directory.',
    permissionLevel: 'auto' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the working directory' },
      },
      required: ['path'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return readFile(resolveRoot(), params.path as string);
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates intermediate directories as needed.',
    permissionLevel: 'confirm' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the working directory' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return writeFile(resolveRoot(), params.path as string, params.content as string);
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories. Returns an array of entries with name and type (file/directory). Use recursive: true to include nested contents (max 1000 entries).',
    permissionLevel: 'auto' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: ".")' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
      required: [] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      const dirPath = (params.path as string) || '.';
      const recursive = (params.recursive as boolean) || false;
      return listFiles(resolveRoot(), dirPath, recursive);
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a file. Cannot delete directories.',
    permissionLevel: 'confirm' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete' },
      },
      required: ['path'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return deleteFile(resolveRoot(), params.path as string);
    },
  },
  {
    name: 'file_move',
    description: 'Move or rename a file. Creates intermediate directories for the destination if needed.',
    permissionLevel: 'confirm' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Current relative path of the file' },
        destination: { type: 'string', description: 'New relative path for the file' },
      },
      required: ['source', 'destination'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return moveFile(resolveRoot(), params.source as string, params.destination as string);
    },
  },
];

export default tools;
