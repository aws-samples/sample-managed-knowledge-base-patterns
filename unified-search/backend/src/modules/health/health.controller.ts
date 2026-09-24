import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';

export interface HealthResponse {
  readonly status: 'ok';
}

/**
 * Liveness endpoint for the load balancer target group.
 *
 * The only unauthenticated route in the application, and the only use of
 * `@Public()`. It deliberately reports nothing about configuration, dependencies,
 * or versions: it is reachable unauthenticated from the load balancer, so it must
 * not become a reconnaissance surface. Dependency health, if added, belongs behind
 * authentication.
 */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
