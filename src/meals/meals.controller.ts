import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { EditionScoped } from '../common/edition-scope/edition-scope.decorator';
import { ThrottleMealCounter } from '../common/throttle/throttle.decorators';
import { AccessTier } from '../delegate/entities/delegate.entity';
import {
  CreateCounterDto,
  CreateMealDto,
  ServeDto,
  UpdateMealDto,
} from './dto/meals.dto';
import { MealsService } from './meals.service';

/** The header the counter page sends: `<counter id>.<secret>` from the counter's private link. */
export const COUNTER_KEY_HEADER = 'x-counter-key';

/** Organisers: an event's meals, and the counters that serve them. */
@ApiTags('meals')
@Controller()
export class MealsController {
  constructor(private readonly meals: MealsService) {}

  @Get('editions/:editionId/meals')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'editionId' })
  @ApiOperation({
    summary:
      'Meals with plates served, counters, and how many people hold tickets',
  })
  list(@Param('editionId', ParseUUIDPipe) editionId: string) {
    return this.meals.list(editionId);
  }

  @Post('meals')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @ApiOperation({ summary: 'Add a meal and its serving window' })
  create(@Body() dto: CreateMealDto) {
    return this.meals.create(dto);
  }

  @Patch('meals/:id')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'meal' })
  @ApiOperation({ summary: 'Rename a meal or change its serving window' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMealDto) {
    return this.meals.update(id, dto);
  }

  @Delete('meals/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'meal' })
  @ApiOperation({ summary: 'Delete a meal nobody has collected yet' })
  @ApiResponse({
    status: 409,
    description: 'Plates already served; the message says how many',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.meals.remove(id);
  }

  @Post('meal-counters')
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'body', key: 'editionId' })
  @ApiOperation({ summary: 'Add a food counter; returns its link key once' })
  createCounter(@Body() dto: CreateCounterDto) {
    return this.meals.createCounter(dto);
  }

  @Post('meal-counters/:id/link')
  @HttpCode(200)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'mealCounter' })
  @ApiOperation({
    summary: 'A new link for the counter; the old one stops working',
  })
  async link(@Param('id', ParseUUIDPipe) id: string) {
    return { key: await this.meals.issueKey(id) };
  }

  @Delete('meal-counters/:id/link')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'mealCounter' })
  @ApiOperation({ summary: "Switch the counter's link off" })
  async unlink(@Param('id', ParseUUIDPipe) id: string) {
    await this.meals.revokeKey(id);
  }

  @Delete('meal-counters/:id')
  @HttpCode(204)
  @Roles(AccessTier.ADMIN, AccessTier.EVENT_ADMIN)
  @EditionScoped({ from: 'param', key: 'id', via: 'mealCounter' })
  @ApiOperation({ summary: 'Remove a counter; plates it served stay counted' })
  async removeCounter(@Param('id', ParseUUIDPipe) id: string) {
    await this.meals.removeCounter(id);
  }
}

/**
 * The counter's scanner page, opened from its private link: no account, the
 * link key in a header. Throttled per counter so a busy lunch queue on the
 * venue's shared IP never runs out of scans.
 */
@ApiTags('meals')
@ApiHeader({
  name: COUNTER_KEY_HEADER,
  description: 'The key from the counter’s private link',
})
@Controller('counter')
export class CounterController {
  constructor(private readonly meals: MealsService) {}

  @Get()
  @Public()
  @ThrottleMealCounter()
  @ApiOperation({
    summary:
      'The counter, its event and its meals, with the one being served now',
  })
  async view(@Headers(COUNTER_KEY_HEADER) key: string | undefined) {
    return this.meals.counterView(await this.meals.counterForKey(key));
  }

  @Post('serve')
  @HttpCode(200)
  @Public()
  @ThrottleMealCounter()
  @ApiOperation({
    summary:
      'Serve one plate on a scanned ticket; refused if already collected',
  })
  @ApiResponse({
    status: 409,
    description: 'Already collected; the message says when and where',
  })
  async serve(
    @Headers(COUNTER_KEY_HEADER) key: string | undefined,
    @Body() dto: ServeDto,
  ) {
    return this.meals.serve(await this.meals.counterForKey(key), dto);
  }
}
