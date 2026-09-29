import {
  WebSocketGateway,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';
import { editionFromJoin } from '../common/realtime/edition-room';

/**
 * `voting:join` with `{ editionId }` joins that event's ballot room; with
 * nothing it joins the summit-wide room, which hears every event (the
 * console joins that one).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class VotingGateway {
  private static room(body: unknown): string {
    const editionId = editionFromJoin(body);
    return editionId ? Rooms.votingEdition(editionId) : Rooms.voting;
  }

  @SubscribeMessage('voting:join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() body?: unknown) {
    const room = VotingGateway.room(body);
    void socket.join(room);
    return { joined: room };
  }

  @SubscribeMessage('voting:leave')
  leave(@ConnectedSocket() socket: Socket, @MessageBody() body?: unknown) {
    const room = VotingGateway.room(body);
    void socket.leave(room);
    return { left: room };
  }
}
