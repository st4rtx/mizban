import { EventEmitter } from 'node:events';

export interface LiveEvent {
  type: 'order' | 'menu';
  orderId?: string;
  tableId?: string | null;
  branchId?: string;
}

/**
 * In-process fan-out for Server-Sent Events. Single node only: when we run a second API
 * instance this must become Postgres LISTEN/NOTIFY or Redis (see HANDOVER, scale section).
 * Clients treat events as "something changed, re-fetch", so a dropped event is repaired by
 * the next fetch and never corrupts state.
 */
class Bus extends EventEmitter {
  publish(restaurantId: string, evt: LiveEvent) {
    this.emit(`r:${restaurantId}`, evt);
  }
  subscribe(restaurantId: string, fn: (e: LiveEvent) => void): () => void {
    const ch = `r:${restaurantId}`;
    this.on(ch, fn);
    return () => this.off(ch, fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(500);
