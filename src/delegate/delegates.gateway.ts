import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';
import { DelegatesService } from './delegates.service';

// Direct-message rooms. Without these handlers nothing ever joined dm:{pairKey}
// or network:{delegateId}, so every 'dm:new' and 'network:updated' emit landed
// in an empty room and no delegate was ever delivered a message.
@WebSocketGateway({ cors: { origin: '*' } })
export class DelegatesGateway {
  // The pair key is derived from the authenticated socket (set by the sessions
  // gateway handshake), never from the client, so a delegate can only join a
  // thread they are one half of.
  private static dmRoom(
    socket: Socket,
    otherDelegateId: string,
  ): string | null {
    const selfId = (socket.data.user as { id?: string } | undefined)?.id;
    if (!selfId || !otherDelegateId || selfId === otherDelegateId) return null;
    return Rooms.dm(DelegatesService.pairKey(selfId, otherDelegateId));
  }

  @SubscribeMessage('dm:join')
  joinDm(
    @ConnectedSocket() socket: Socket,
    @MessageBody() otherDelegateId: string,
  ) {
    const room = DelegatesGateway.dmRoom(socket, otherDelegateId);
    if (!room) return { joined: null };
    socket.join(room);
    return { joined: otherDelegateId };
  }

  @SubscribeMessage('dm:leave')
  leaveDm(
    @ConnectedSocket() socket: Socket,
    @MessageBody() otherDelegateId: string,
  ) {
    const room = DelegatesGateway.dmRoom(socket, otherDelegateId);
    if (room) socket.leave(room);
    return { left: otherDelegateId };
  }

  // Personal room: keeps a delegate reachable for incoming DMs and connection
  // updates while they are anywhere in the app, not just inside the thread.
  @SubscribeMessage('network:join')
  joinNetwork(@ConnectedSocket() socket: Socket) {
    const selfId = (socket.data.user as { id?: string } | undefined)?.id;
    if (!selfId) return { joined: null };
    socket.join(Rooms.network(selfId));
    return { joined: selfId };
  }

  @SubscribeMessage('network:leave')
  leaveNetwork(@ConnectedSocket() socket: Socket) {
    const selfId = (socket.data.user as { id?: string } | undefined)?.id;
    if (selfId) socket.leave(Rooms.network(selfId));
    return { left: selfId ?? null };
  }
}
