import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { AccessTier } from '../../delegate/entities/delegate.entity';
import { cleanState } from './desk-remote';
import { deskRoom, DeskRemoteService } from './desk-remote.service';

const STAFF = new Set<string>([
  AccessTier.ADMIN,
  AccessTier.EVENT_ADMIN,
  AccessTier.SESSION_ADMIN,
]);

/** A sound desk's report: kept for the remote panel, and the desk's socket put where requests reach it. */
@WebSocketGateway({ cors: { origin: '*' } })
export class DeskRemoteGateway {
  constructor(private readonly desks: DeskRemoteService) {}

  @SubscribeMessage('desk:state')
  async state(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const role = (socket.data.user as { role?: string } | undefined)?.role;
    if (!role || !STAFF.has(role)) return { ok: false };
    const state = cleanState(body);
    if (!state) return { ok: false };
    await socket.join(deskRoom(state.deskId));
    await this.desks.report(state);
    return { ok: true };
  }
}
