import { Global, Module } from '@nestjs/common';
import { EditionAccessService } from './edition-access.service';

/** Event organisers' editions, for the guard and for handlers that filter lists by them. */
@Global()
@Module({
  providers: [EditionAccessService],
  exports: [EditionAccessService],
})
export class EditionScopeModule {}
