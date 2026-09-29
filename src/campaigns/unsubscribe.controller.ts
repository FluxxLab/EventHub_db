import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsString, MaxLength } from 'class-validator';
import { Repository } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';
import { ThrottleLookup } from '../common/throttle/throttle.decorators';
import { EmailSuppression } from './entities/email-suppression.entity';
import { UnsubscribeLinks } from './unsubscribe-links';

class UnsubscribeDto {
  @IsString()
  @MaxLength(600)
  t: string;
}

const NOT_OURS =
  'This link is not complete. Open it again from the email, or reply to the email to be taken off the list.';

/**
 * Opting out of campaign emails, from the link every campaign email
 * carries. No account: the signed token says whose address it is.
 */
@ApiTags('campaigns')
@Controller('email')
export class UnsubscribeController {
  constructor(
    @InjectRepository(EmailSuppression)
    private readonly suppressions: Repository<EmailSuppression>,
    private readonly links: UnsubscribeLinks,
  ) {}

  private email(token: string | undefined): string {
    const email = this.links.verify(token);
    if (!email) throw new BadRequestException(NOT_OURS);
    return email;
  }

  @Get('unsubscribe')
  @Public()
  @ThrottleLookup()
  @ApiOperation({
    summary: 'Whose link it is, and whether they are already unsubscribed',
  })
  async status(@Query('t') t: string) {
    const email = this.email(t);
    return { email, unsubscribed: await this.suppressions.existsBy({ email }) };
  }

  @Post('unsubscribe')
  @HttpCode(200)
  @Public()
  @ThrottleLookup()
  @ApiOperation({ summary: 'Stop campaign emails to this address' })
  async unsubscribe(@Body() dto: UnsubscribeDto) {
    const email = this.email(dto.t);
    await this.suppressions.upsert({ email, source: 'page' }, ['email']);
    return { email, unsubscribed: true };
  }

  @Post('resubscribe')
  @HttpCode(200)
  @Public()
  @ThrottleLookup()
  @ApiOperation({ summary: 'Get campaign emails again' })
  async resubscribe(@Body() dto: UnsubscribeDto) {
    const email = this.email(dto.t);
    await this.suppressions.delete({ email });
    return { email, unsubscribed: false };
  }

  /** RFC 8058: the mail app posts `List-Unsubscribe=One-Click` here, with the token in the address. */
  @Post('unsubscribe/one-click')
  @HttpCode(200)
  @Public()
  @ThrottleLookup()
  @ApiOperation({
    summary: "The mail app's own Unsubscribe button (one-click)",
  })
  async oneClick(@Query('t') t: string) {
    const email = this.email(t);
    await this.suppressions.upsert({ email, source: 'one_click' }, ['email']);
    return { unsubscribed: true };
  }
}
