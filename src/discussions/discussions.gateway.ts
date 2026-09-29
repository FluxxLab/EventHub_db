import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class DiscussionsGateway {
  @SubscribeMessage('discussions:join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() sessionId: string) {
    socket.join(Rooms.discussion(sessionId));
    return { joined: sessionId };
  }

  @SubscribeMessage('discussions:leave')
  leave(@ConnectedSocket() socket: Socket, @MessageBody() sessionId: string) {
    socket.leave(Rooms.discussion(sessionId));
    return { left: sessionId };
  }
}
