import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { applyDecorators } from '@nestjs/common';
import { InjectDb, pgCode } from '../../database/database';
import type { Db } from '../../database/database';
import { AppException } from '../errors/app-exception';
import { JwtVerifier } from './jwt-verifier';

export type PartnerRole = 'owner' | 'manager' | 'staff';
export type PartnerStatus = 'draft' | 'pending_verification' | 'approved' | 'rejected' | 'suspended';

export interface PartnerMembership {
  partnerId: string;
  role: PartnerRole;
  status: PartnerStatus;
  countryCode: string;
  displayName: string;
}

/** Server-resolved identity. Never derived from client-supplied ids or roles. */
export interface AuthUser {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  partner: PartnerMembership | null;
}

export type AuthedRequest = Request & { auth?: AuthUser; requestId?: string };

const PUBLIC = 'rove:public';
const PARTNER = 'rove:partner';
const ADMIN = 'rove:admin';

export interface PartnerRouteOptions {
  /** owner or manager only ([owner] in CONTRACTS §9). */
  manage?: boolean;
  /** Partner must be `approved` (otherwise 403 PARTNER_NOT_APPROVED). */
  approved?: boolean;
}

/** `[pub]`: no auth required; a valid token is still resolved (e.g. for `isFavorite`). */
export const Public = () => SetMetadata(PUBLIC, true);

/** `[partner]` / `[owner]` routes. */
export const PartnerRoute = (opts: PartnerRouteOptions = {}) =>
  applyDecorators(SetMetadata(PARTNER, opts), ApiBearerAuth());

/** `[admin]` routes. */
export const AdminRoute = () => applyDecorators(SetMetadata(ADMIN, true), ApiBearerAuth());

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser | undefined => ctx.switchToHttp().getRequest<AuthedRequest>().auth,
);

/** Partner membership of the caller; guaranteed non-null on `@PartnerRoute` handlers. */
export const CurrentPartner = createParamDecorator((_: unknown, ctx: ExecutionContext): PartnerMembership => {
  const partner = ctx.switchToHttp().getRequest<AuthedRequest>().auth?.partner;
  if (!partner) throw new AppException('PARTNER_REQUIRED');
  return partner;
});

@Injectable()
export class AuthService {
  /** Users whose profile row is known to exist (avoids an upsert on every request). */
  private readonly knownProfiles = new Set<string>();

  constructor(
    private readonly verifier: JwtVerifier,
    @InjectDb() private readonly db: Db,
  ) {}

  async authenticate(token: string): Promise<AuthUser> {
    const { sub, email } = await this.verifier.verify(token);
    if (!this.knownProfiles.has(sub)) {
      try {
        await this.db
          .insertInto('profiles')
          .values({ user_id: sub, email: email ?? null })
          .onConflict((oc) => oc.column('user_id').doNothing())
          .execute();
      } catch (err) {
        // FK violation: the auth user no longer exists.
        if (pgCode(err) === '23503') throw new AppException('UNAUTHENTICATED');
        throw err;
      }
      if (this.knownProfiles.size > 50_000) this.knownProfiles.clear();
      this.knownProfiles.add(sub);
    }
    return this.resolve(sub);
  }

  async resolve(userId: string): Promise<AuthUser> {
    const row = await this.db
      .selectFrom('profiles as pr')
      .leftJoin('partner_members as pm', 'pm.user_id', 'pr.user_id')
      .leftJoin('partners as p', 'p.id', 'pm.partner_id')
      .select([
        'pr.user_id',
        'pr.email',
        'pr.is_admin',
        'pm.partner_id',
        'pm.role',
        'p.status as partner_status',
        'p.country_code as partner_country',
        'p.display_name as partner_name',
      ])
      .where('pr.user_id', '=', userId)
      .executeTakeFirst();
    if (!row) {
      this.knownProfiles.delete(userId);
      throw new AppException('UNAUTHENTICATED');
    }
    return {
      userId: row.user_id,
      email: row.email,
      isAdmin: row.is_admin,
      partner: row.partner_id
        ? {
            partnerId: row.partner_id,
            role: row.role as PartnerRole,
            status: row.partner_status as PartnerStatus,
            countryCode: row.partner_country as string,
            displayName: row.partner_name as string,
          }
        : null,
    };
  }
}

/** Global guard: authentication + role resolution + partner/admin checks. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, targets);
    const partnerOpts = this.reflector.getAllAndOverride<PartnerRouteOptions>(PARTNER, targets);
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN, targets);

    const header = req.header('authorization');
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token) {
      if (isPublic) return true;
      throw new AppException('UNAUTHENTICATED');
    }
    req.auth = await this.auth.authenticate(token);

    if (adminOnly && !req.auth.isAdmin) throw new AppException('FORBIDDEN');
    if (partnerOpts) {
      const partner = req.auth.partner;
      if (!partner) throw new AppException('PARTNER_REQUIRED');
      if (partnerOpts.manage && partner.role === 'staff') {
        throw new AppException('FORBIDDEN', 'Only the company owner or a manager can do this.');
      }
      if (partnerOpts.approved && partner.status !== 'approved') {
        throw new AppException('PARTNER_NOT_APPROVED');
      }
    }
    return true;
  }
}
