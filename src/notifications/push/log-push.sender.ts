import { Injectable, Logger } from '@nestjs/common';
import { PushSender, PushTarget } from './push-sender.interface';

@Injectable()
export class LogPushSender implements PushSender {
  private readonly logger = new Logger('LogPushSender');

  async sendToTokens(targets: PushTarget[], title: string, body: string) {
    this.logger.log(
      `[dev] would push "${title}" — "${body}" to ${targets.length} device(s)`,
    );
    return { invalidTokens: [] };
  }
}
