import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';

/**
 * One room for every poll of the summit, like trivia: a phone joins once
 * when the polls card mounts and hears `poll:opened`, `poll:results` and
 * `poll:closed` for whatever the stage fires. The handshake auth in
 * SessionsGateway has already run, so nothing is checked here.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class PollsGateway {
  @SubscribeMessage('polls:join')
  join(@ConnectedSocket() socket: Socket) {
    void socket.join(Rooms.polls);
    return { joined: Rooms.polls };
  }

  @SubscribeMessage('polls:leave')
  leave(@ConnectedSocket() socket: Socket) {
    void socket.leave(Rooms.polls);
    return { left: Rooms.polls };
  }
}
