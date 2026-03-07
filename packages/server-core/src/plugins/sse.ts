import fp from 'fastify-plugin';
import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

/**
 * Simple typed SSE hub for broadcasting events to connected clients.
 */
export class SseHub {
  private emitter = new EventEmitter();
  private eventId = 0;

  /** Broadcast an event to all connected SSE clients. */
  broadcast(event: string, data: unknown): void {
    this.eventId++;
    this.emitter.emit('message', {
      event,
      data,
      id: String(this.eventId),
    } satisfies SseEvent);
  }

  /** Subscribe a Fastify reply to the SSE stream. */
  subscribe(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const onMessage = (evt: SseEvent) => {
      reply.raw.write(`id: ${evt.id}\n`);
      reply.raw.write(`event: ${evt.event}\n`);
      reply.raw.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    };

    this.emitter.on('message', onMessage);

    // Keep-alive heartbeat
    const heartbeat = setInterval(() => {
      reply.raw.write(':heartbeat\n\n');
    }, 30_000);

    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      this.emitter.off('message', onMessage);
    });
  }
}

/**
 * SSE plugin — provides `fastify.sse` hub and GET /stream endpoint.
 */
async function ssePluginFn(fastify: FastifyInstance): Promise<void> {
  const hub = new SseHub();
  fastify.decorate('sse', hub);

  fastify.get(
    '/stream',
    {
      schema: {
        tags: ['health'],
        description: 'Server-Sent Events stream for real-time updates',
      },
    },
    async (_req, reply) => {
      hub.subscribe(reply);
    },
  );
}

export const ssePlugin = fp(ssePluginFn, {
  name: 'iw-sse',
  fastify: '5.x',
});
