import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'authIsPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is applied globally, so this is the *only* way to opt out and
 * every use is therefore visible in one grep. That is the point: each public
 * route is opted out individually and on the record, whereas a global bypass
 * constant would open every route at once.
 *
 * Today only the load balancer health check uses this. Anything else needs a
 * written justification in review — a public route on this service is a route
 * that cannot filter by document permissions.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
