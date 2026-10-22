import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS } from '../../common/redis/redis.module';
import { RealtimeService } from '../../common/realtime/realtime.service';
import type { DeskAction, DeskCommand, DeskState } from './desk-remote';

/** A desk not heard from in this long is gone (closed, asleep, off the network). */
const STALE_S = 45;
const key = (deskId: string) => `desk:state:${deskId}`;
export const deskRoom = (deskId: string) => `capture-desk:${deskId}`;

/** Desk reports kept in Redis, so either API instance can list them; requests sent to the desk's socket room. */
@Injectable()
export class DeskRemoteService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
  ) {}

  async report(state: DeskState): Promise<void> {
    await this.redis.set(
      key(state.deskId),
      JSON.stringify(state),
      'EX',
      STALE_S,
    );
  }

  async list(): Promise<DeskState[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, found] = await this.redis.scan(
        cursor,
        'MATCH',
        'desk:state:*',
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0' && keys.length < 200);
    if (!keys.length) return [];
    const values = await this.redis.mget(keys);
    return values
      .filter((v): v is string => !!v)
      .map((v) => JSON.parse(v) as DeskState)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Passes a request to the desk; it answers by reporting its new state. */
  async command(
    deskId: string,
    action: DeskAction,
    room: string,
    source: string | undefined,
    by: string,
  ): Promise<{ sent: string }> {
    const raw = await this.redis.get(key(deskId));
    if (!raw)
      throw new NotFoundException(
        'That desk is not online. Check its laptop is on and the Sound desk page is open.',
      );
    const state = JSON.parse(raw) as DeskState;
    if (!state.rooms.some((r) => r.room === room))
      throw new BadRequestException(`${room} is not on that desk.`);
    if (
      action === 'patch' &&
      source &&
      !state.channels.some((c) => c.value === source)
    ) {
      throw new BadRequestException('That channel is not on that desk.');
    }
    const command: DeskCommand = {
      id: randomUUID(),
      action,
      room,
      ...(action === 'patch' ? { source: source ?? '' } : {}),
      by,
    };
    this.realtime.emitToRoom(deskRoom(deskId), 'desk:command', command);
    return { sent: command.id };
  }
}
