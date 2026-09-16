import { StdioServerTransport as Transport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './module/server.js';

const instance = await server({ root: process.argv[2] || process.cwd(), passive: process.argv.includes('--passive') });
const transport = new Transport();
await instance.connect(transport);
process.once('SIGINT', () => void instance.close());
process.once('SIGTERM', () => void instance.close());
