import { Injectable } from '@nestjs/common';
import { DelegatesService } from '../delegate/delegates.service';
import { EditionsService } from '../editions/editions.service';
import { SessionsService } from '../sessions/sessions.service';
import { QuerySearchDto } from './dto/query-search.dto';

@Injectable()
export class SearchService {
  constructor(
    private readonly delegate: DelegatesService,
    private readonly session: SessionsService,
    private readonly editions: EditionsService,
  ) {}

  async search(dto: QuerySearchDto, isAdmin = false) {
    const q = this.escapeLike(dto.q);
    const limit = dto.limit ?? 10;

    const [sessions, speakers, delegates, editions] = await Promise.all([
      this.session.searchSessions(q, limit, isAdmin),
      this.session.searchSpeakers(q, limit, isAdmin),
      this.delegate.searchDelegates(q, limit),
      this.editions.browse({ q: dto.q, when: 'all', limit }),
    ]);
    // The app labels a session with its summit; one lookup for every hit.
    const editionNames = await this.editions.namesByIds(
      sessions.map((s) => s.editionId).filter((id): id is string => !!id),
    );

    return {
      editions,
      sessions: sessions.map((s) => ({
        ...s,
        editionName: s.editionId
          ? (editionNames.get(s.editionId) ?? null)
          : null,
      })),
      speakers,
      delegates: delegates.map((d) => ({
        id: d.id,
        name: d.name,
        title: d.title,
        organisation: d.organisation,
        country: d.country,
        track: d.track,
      })),
    };
  }

  /**
   * % and _ are LIKE wildcards - a search for '50% should match thw literal text
   */
  private escapeLike(input: string): string {
    return input.replace(/[%_]/g, '\\$&');
  }
}
