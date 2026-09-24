import { beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('reports ok', () => {
    expect(controller.check()).toEqual({ status: 'ok' });
  });

  // This route is unauthenticated and reachable from the load balancer, so
  // assert it stays a bare status rather than accumulating diagnostic fields.
  it('exposes nothing beyond a status', () => {
    expect(Object.keys(controller.check())).toEqual(['status']);
  });
});
