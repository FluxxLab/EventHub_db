import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';

/**
 * Room membership for the questions queue of one session. The handshake is
 * authenticated once in the sessions gateway; this only moves sockets in and
 * out of `questions:{sessionId}`.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class QuestionsGateway {
  @SubscribeMessage('questions:join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() sessionId: string) {
    void socket.join(Rooms.questions(sessionId));
    return { joined: sessionId };
  }

  @SubscribeMessage('questions:leave')
  leave(@ConnectedSocket() socket: Socket, @MessageBody() sessionId: string) {
    void socket.leave(Rooms.questions(sessionId));
    return { left: sessionId };
  }
}
