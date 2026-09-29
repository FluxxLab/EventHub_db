import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';
import { DelegatesService } from './delegates.service';
import { PRESENCE_BATCH_MAX } from './dto/presence-query.dto';
import { AccessTier, STAFF_TIERS } from './entities/delegate.entity';
import { PresenceService, type PresenceView } from './presence.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A presence:watch / presence:unwatch body: one id or a list, capped. */
function presenceIds(body: unknown): string[] {
  const list = Array.isArray(body) ? body : [body];
  const ids = list.filter(
    (v): v is string => typeof v === 'string' && UUID.test(v),
  );
  return [...new Set(ids)].slice(0, PRESENCE_BATCH_MAX);
}

/**
 * Presence: a signed-in delegate's sockets make them online (PresenceService
 * keeps the cross-instance count). Console staff are not attendees and are
 * not tracked. Watching someone's status is opt-in per id, and only granted
 * for ids the viewer may see (DelegatesService.presenceVisibleIds).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class PresenceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PresenceGateway.name);

  constructor(
    private readonly delegates: DelegatesService,
    private readonly presence: PresenceService,
  ) {}

  afterInit(server: Server): void {
    this.presence.bindServer(server);
  }

  handleConnection(socket: Socket): void {
    const user = socket.data.user as { id?: string; role?: string } | undefined;
    if (!user?.id || STAFF_TIERS.includes(user.role as AccessTier)) return;
    socket.data.presenceId = user.id;
    // lets a block pull this delegate's sockets out of the other's presence room
    void socket.join(Rooms.presenceSelf(user.id));
    void this.presence
      .connected(user.id)
      .catch((e) => this.logger.warn(`presence not recorded: ${String(e)}`));
  }

  handleDisconnect(socket: Socket): void {
    const id = socket.data.presenceId as string | undefined;
    if (id) this.presence.disconnected(id);
  }

  /**
   * Start receiving presence:update for these delegates. The ack is their
   * current status, so the client needs no separate fetch; ids the viewer
   * may not see come back offline and are not joined.
   */
  @SubscribeMessage('presence:watch')
  async watch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ presence: PresenceView[] }> {
    const selfId = (socket.data.user as { id?: string } | undefined)?.id;
    const ids = presenceIds(body);
    if (!selfId || ids.length === 0) return { presence: [] };
    const allowed = await this.delegates.presenceVisibleIds(selfId, ids);
    const joined = new Set(this.presence.watch(socket, allowed));
    const views = new Map(
      (await this.presence.lookup([...joined])).map((p) => [p.id, p]),
    );
    return {
      presence: ids.map(
        (id) => views.get(id) ?? { id, online: false, lastSeenAt: null },
      ),
    };
  }

  @SubscribeMessage('presence:unwatch')
  unwatch(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const ids = presenceIds(body);
    this.presence.unwatch(socket, ids);
    return { left: ids };
  }
}
