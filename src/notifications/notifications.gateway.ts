import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { Rooms } from '../common/realtime/realtime.service';
import { DelegatesService } from '../delegate/delegates.service';
import { AudienceSegment } from './entities/notification.entity';

@WebSocketGateway({ cors: { origin: '*' } })
export class NotificationsGateway {
  constructor(private readonly delegatesService: DelegatesService) {}

  @SubscribeMessage('notifications:join')
  async join(@ConnectedSocket() socket: Socket) {
    const user = socket.data.user as { id: string; role: string } | undefined;
    if (!user) return { error: 'unauthorized' };

    /**
     * Membership is DERIVED from identity, never from a client payload, and
     * from the same resolver the push processor and the inbox use - three
     * copies of these rules is how an announcement ends up delivered by one
     * path and invisible to another.
     */
    const segments = await this.delegatesService.segmentsFor(user.id);

    for (const s of segments) socket.join(Rooms.notifications(s));
    return { joined: segments };
  }

  @SubscribeMessage('notifications:leave')
  leave(@ConnectedSocket() socket: Socket) {
    for (const s of Object.values(AudienceSegment))
      socket.leave(Rooms.notifications(s));
    return { left: true };
  }
}
