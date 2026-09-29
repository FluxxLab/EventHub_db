import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions, Socket } from 'socket.io';

/**
 * Nest attaches one `disconnect` listener per gateway to every socket (and one
 * `connection` listener per gateway to the namespace), and
 * socket.io adds its own, so a connection carries (gateways + 1) of them - a
 * fixed number, not a leak. Node warns past 10, which the eleventh gateway
 * crossed. Headroom for more gateways; a real leak would still blow past it.
 */
const MAX_LISTENERS_PER_SOCKET = 50;

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  constructor(app: INestApplication, host: string, port: number) {
    super(app);
    const pubClient = new Redis({ host, port });
    const subClient = pubClient.duplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    // Each gateway also adds a `connection` listener to the shared namespace.
    server.sockets.setMaxListeners(MAX_LISTENERS_PER_SOCKET);
    // Registered before any gateway binds its handlers, so it runs first.
    server.on('connection', (socket: Socket) =>
      socket.setMaxListeners(MAX_LISTENERS_PER_SOCKET),
    );
    return server;
  }
}
