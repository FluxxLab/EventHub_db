import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from '../common/decorators/public.decorator';
import { PrefillQueryDto } from './dto/prefill.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/reset-password.dto';
import { OtpService } from './otp.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from './strategies/jwt.stategies';
import { ChangePasswordDto } from './dto/change-password.dto';
import { GoogleSignInDto } from './dto/google-sign-in.dto';
import {
  ThrottleCredentials,
  ThrottleRefresh,
} from '../common/throttle/throttle.decorators';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly otpService: OtpService,
  ) {}

  @Public()
  @Post('login')
  @ThrottleCredentials()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
  })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto.email, dto.password, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  }

  @Public()
  @Post('refresh')
  @ThrottleRefresh()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Refresh Token',
  })
  @ApiResponse({
    status: 200,
    description: 'Token refreshed successfully',
  })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  }

  @Public()
  @Post('register')
  @ThrottleCredentials()
  @ApiOperation({
    summary: 'Self registration with tier verification (scope addition)',
  })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.registration(dto, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  }

  @Public()
  @Get('register/prefill')
  @ApiOperation({
    summary: 'What an unclaimed invite code already knows about the invitee',
  })
  @ApiResponse({
    status: 200,
    description: '{ email, name, organisation, title } - any may be null',
  })
  @ApiResponse({ status: 404, description: 'Code unknown or already used' })
  prefill(@Query() query: PrefillQueryDto) {
    return this.authService.registrationPrefill(query.code);
  }

  @Public()
  @Post('register/request-otp')
  @ThrottleCredentials()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Step 1 of Registration - Request OTP SMS/Email',
  })
  @ApiResponse({
    status: 204,
    description: 'OTP request successful',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or user already exists',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests',
  })
  async requestOtp(@Body() dto: RequestOtpDto) {
    await this.otpService.requestOtp(dto.email, dto.channel, dto.phone);
  }

  @Public()
  @Post('forgot-password')
  @ThrottleCredentials()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Step 1 of password reset - email a code to the account',
  })
  @ApiResponse({
    status: 200,
    description: 'Always 200, whether or not the email has an account',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @ThrottleCredentials()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Step 2 of password reset - code plus new password',
  })
  @ApiResponse({
    status: 200,
    description: 'Password changed; every existing session is signed out',
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired code' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.email, dto.otp, dto.newPassword);
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Change password while signed in; signs out every other session and returns a fresh token pair',
  })
  @ApiResponse({
    status: 200,
    description: '{ accessToken, refreshToken, refreshTokenId }, as login',
  })
  @ApiResponse({
    status: 400,
    description: 'Your current password is incorrect',
  })
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.authService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      { userAgent: req.headers['user-agent'], ip: req.ip },
    );
  }

  @Public()
  @Post('google')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sign in or sign up with a Google ID token; creating or claiming an account needs consent: true',
  })
  @ApiResponse({
    status: 200,
    description: '{ accessToken, refreshToken, refreshTokenId }, as login',
  })
  @ApiResponse({
    status: 400,
    description:
      "{ statusCode: 400, message, code: 'consent_required' } when a new account needs consent",
  })
  @ApiResponse({
    status: 401,
    description: 'Token invalid, expired or issued to another app',
  })
  @ApiResponse({
    status: 409,
    description: 'The email belongs to a placeholder account',
  })
  @ApiResponse({ status: 503, description: 'Google sign-in is not configured' })
  google(@Body() dto: GoogleSignInDto, @Req() req: Request) {
    return this.authService.googleSignIn(dto.idToken, dto.consent, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke refresh token + blacklist the presentend access token',
  })
  async logout(@Body() dto: RefreshDto, @CurrentUser() user: AuthUser) {
    await this.authService.logout(dto.refreshToken, user.jti, user.exp);
  }
}
