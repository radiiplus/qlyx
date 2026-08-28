import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID as uuid, timingSafeEqual as safe } from 'node:crypto';
import { pathToFileURL as url } from 'node:url';
import WebSocket, { type RawData } from 'ws';
import {
  Engine,
  Fault,
  Tool,
  request,
  setting,
  type Config,
  type Reply,
} from './tool.ts';

export type Options = {
  base?: string;
  config?: Config;
  logger?: boolean;
};

function failure(error: unknown): Reply {
  const fault = error instanceof Fault ? error : new Fault('UNKNOWN', (error as Error).message);
  return {
    id: uuid(),
    action: '',
    ok: false,
    error: { code: fault.code, message: fault.message },
  };
}

function token(actual: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && safe(left, right);
}

function local(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function send(socket: WebSocket, value: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

async function handle(socket: WebSocket, engine: Engine, data: RawData, binary: boolean): Promise<void> {
  try {
    if (binary) throw new Fault('MESSAGE', 'Binary WebSocket messages are not supported.');
    const value: unknown = JSON.parse(data.toString());
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).kind === 'ping') {
      send(socket, { kind: 'pong' });
      return;
    }
    const work = request(value);
    send(socket, await engine.run(work));
  } catch (error) {
    const fault = error instanceof SyntaxError ? new Fault('JSON', error.message) : error;
    send(socket, failure(fault));
  }
}

export async function build(options: Options = {}): Promise<FastifyInstance> {
  const config = options.config || setting();
  const secret = process.env.READER_TOKEN || config.server.token;
  if (!local(config.server.host) && !secret) {
    throw new Fault('AUTH', 'A bearer token is required when the server is not bound to loopback.');
  }

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: config.server.bytes,
  });
  await app.register(websocket, {
    options: { maxPayload: config.server.bytes },
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });

  app.get('/health', async () => ({ ok: true }));
  app.get(config.server.path, {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!token(request.headers.authorization, secret)) {
        await reply.code(401).send({ error: { code: 'AUTH', message: 'Bearer token is invalid.' } });
      }
    },
  }, (socket) => {
    const engine = new Engine(new Tool(options.base || process.cwd(), config), config);
    socket.on('message', (data, binary) => {
      void handle(socket, engine, data, binary);
    });
    socket.once('close', () => {
      void engine.close();
    });
  });

  return app;
}

async function run(): Promise<void> {
  try {
    const config = setting();
    const host = process.env.READER_HOST;
    const port = process.env.READER_PORT;
    if (host) config.server.host = host;
    if (port) {
      const value = Number(port);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Fault('CONFIG', 'READER_PORT must be an integer from 0 through 65535.');
      }
      config.server.port = value;
    }
    const app = await build({ config });
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (error) {
    const fault = error instanceof Fault ? error : new Fault('SERVER', (error as Error).message);
    process.stderr.write(`${JSON.stringify({ error: { code: fault.code, message: fault.message } }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? url(process.argv[1]).href : '';
if (import.meta.url === entry) await run();
