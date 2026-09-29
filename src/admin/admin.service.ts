import { Injectable } from '@nestjs/common';
import { RealtimeService, Rooms } from '../common/realtime/realtime.service';
import { DelegatesService } from '../delegate/delegates.service';
import { SessionsService } from '../sessions/sessions.service';
import { VotingService } from '../voting/voting.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly delegate: DelegatesService,
    private readonly session: SessionsService,
    private readonly voting: VotingService,
    private readonly realtime: RealtimeService,
  ) {}

  async overview() {
    const [delegate, sessions, topPitches, liveSessions] = await Promise.all([
      this.delegate.segmentStats(),
      this.session.statusCounts(),
      // Admin surface: includes pitches on topics that have not opened yet,
      // which are withheld everywhere a delegate can reach.
      this.voting.topPitches(5, true),
      this.session.findLiveNow(),
    ]);

    const viewersPerSession = await Promise.all(
      liveSessions.map(async (s) => ({
        sessionsId: s.id,
        title: s.title,
        viewers: await this.realtime.roomSize(Rooms.session(s.id)),
      })),
    );
    const streaming = viewersPerSession.reduce((sum, s) => sum + s.viewers, 0);

    return { delegate, sessions, streaming, viewersPerSession, topPitches };
  }
}
