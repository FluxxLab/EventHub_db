import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { SessionsService } from './sessions.service';

@WebSocketGateway({ cors: { origin: '*' } }) //tighten origin in production
export class SessionsGateway implements OnGatewayInit {
  private readonly logger = new Logger(SessionsGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeService,
    private readonly sessions: SessionsService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.bindServer(server);

    /**
     * handshake auth: rejects without a valid access token
     *
     */
    server.use((socket, next) => {
      try {
        const token = socket.handshake.auth?.token as string | undefined;

        if (!token) throw new UnauthorizedException();

        const payload = this.jwt.verify(token);

        if (payload.typ === 'refresh') throw new UnauthorizedException();
        socket.data.user = { id: payload.sub, role: payload.role };
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  @SubscribeMessage('session:join')
  joinSession(
    @ConnectedSocket() socket: Socket,
    @MessageBody() sessionId: string,
  ) {
    socket.join(Rooms.session(sessionId));

    // Joining a live session is what counts as attending it (FR-16 gates the
    // certificate on this). Fire and forget: a delegate watching a session must
    // never be dropped from the room because the write failed.
    const delegateId = (socket.data.user as { id?: string } | undefined)?.id;
    if (delegateId) {
      void this.sessions
        .recordAttendance(delegateId, sessionId)
        .catch((e) => this.logger.warn(`attendance not recorded: ${e}`));
    }

    return { joined: sessionId };
  }

  @SubscribeMessage('session:leave')
  leaveSession(
    @ConnectedSocket() socket: Socket,
    @MessageBody() sessionId: string,
  ) {
    socket.leave(Rooms.session(sessionId));
    return { left: sessionId };
  }
}
