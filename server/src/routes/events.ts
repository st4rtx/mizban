import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../app.js';
import { bus, type LiveEvent } from '../lib/events.js';

export function eventRoutes(app: FastifyInstance, { guard }: Ctx) {
  // Server-Sent Events: tells the client "something changed, refetch". Never carries data itself,
  // so a lost event cannot leave a screen wrong for longer than the client's own refresh interval.
  app.get('/events', { preHandler: guard() }, (req, reply) => {
    const user = req.user!;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx / CDN: do not buffer
    });
    reply.raw.write('retry: 3000\n\n');
    const send = (e: LiveEvent) => {
      // Staff pinned to a branch never receive another branch's events.
      if (user.branchId && e.branchId && e.branchId !== user.branchId) return;
      reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify({ orderId: e.orderId, tableId: e.tableId, branchId: e.branchId })}\n\n`);
    };
    const off = bus.subscribe(user.restaurantId, send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
    reply.hijack();
  });

  // Long-poll twin of /events for networks where a CDN buffers streaming responses (ArvanCloud does).
  // Holds the request until something relevant changes or ~25 s pass; every response is complete, so nothing
  // can be buffered half-way. Client refetches only when `changed` is true.
  app.get('/changes', { preHandler: guard() }, (req, reply) => {
    const user = req.user!;
    let done = false;
    const finish = (changed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      reply.send({ changed });
    };
    const off = bus.subscribe(user.restaurantId, (e: LiveEvent) => {
      if (user.branchId && e.branchId && e.branchId !== user.branchId) return;
      finish(true);
    });
    const timer = setTimeout(() => finish(false), 25_000);
    req.raw.on('close', () => {
      done = true;
      clearTimeout(timer);
      off();
    });
    return reply;
  });
}
