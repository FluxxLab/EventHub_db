import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccessTier } from '../delegate/entities/delegate.entity';
import type { AuthUser } from '../auth/strategies/jwt.stategies';
import { DelegateDirectoryDto } from '../delegate/dto/delegate-directory.dto';
import { VerifyPassDto } from './dto/verify-pass.dto';
import { PassService } from './pass.service';

// FR-07 QR digital pass.
@ApiTags('pass')
@ApiBearerAuth()
@Controller('pass')
export class PassController {
  constructor(private readonly service: PassService) {}

  @Get()
  @ApiOperation({ summary: "The caller's QR pass" })
  @ApiResponse({ status: 503, description: 'Pass signing keys are not set' })
  issue(@CurrentUser() user: AuthUser) {
    return this.service.issue(user.id);
  }

  @Post('verify')
  @Roles(AccessTier.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Gate scanner: verify a scanned pass and resolve the delegate',
  })
  @ApiResponse({ status: 503, description: 'Pass signing keys are not set' })
  verify(@Body() dto: VerifyPassDto) {
    return this.service.verify(dto.pass);
  }

  /**
   * Any signed-in delegate: the networking scanner resolves a scanned My QR
   * to the holder's directory card. The gate's /verify stays admin-only and
   * keeps its verdict shape.
   */
  @Post('resolve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Networking scanner: resolve a scanned pass to the holder's profile",
  })
  @ApiResponse({ status: 200, type: DelegateDirectoryDto })
  @ApiResponse({ status: 400, description: 'Not a valid or current pass' })
  @ApiResponse({ status: 404, description: 'Delegate not found or flagged' })
  @ApiResponse({ status: 503, description: 'Pass signing keys are not set' })
  resolve(@Body() dto: VerifyPassDto) {
    return this.service.resolve(dto.pass);
  }

  /**
   * For scanners that have to work without a network. Handing out the public
   * half proves nothing to an attacker: it verifies signatures, it cannot make
   * them.
   */
  @Get('public-key')
  @Roles(AccessTier.ADMIN)
  @ApiOperation({ summary: 'Public key for offline pass verification' })
  @ApiResponse({ status: 503, description: 'Pass signing keys are not set' })
  publicKey() {
    return this.service.publicKey();
  }
}
