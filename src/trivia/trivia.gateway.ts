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
 * `trivia:join` with `{ editionId }` joins that event's trivia room (its
 * questions, reveals and leaderboard); with nothing it joins the
 * summit-wide room, which hears every event's questions (the console).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class TriviaGateway {
  private static room(body: unknown): string {
    const editionId = editionFromJoin(body);
    return editionId ? Rooms.triviaEdition(editionId) : Rooms.trivia;
  }

  @SubscribeMessage('trivia:join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() body?: unknown) {
    const room = TriviaGateway.room(body);
    void socket.join(room);
    return { joined: room };
  }

  @SubscribeMessage('trivia:leave')
  leave(@ConnectedSocket() socket: Socket, @MessageBody() body?: unknown) {
    const room = TriviaGateway.room(body);
    void socket.leave(room);
    return { left: room };
  }
}
