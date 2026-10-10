import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AppException } from '../common/errors/app-exception';
import { KYSELY } from '../database/database';
import type { Db } from '../database/database';
import { AdminPartnersQuery, AdminService, AdminVehiclesQuery, DocKind } from '../modules/admin/admin.service';
import { ExpiryService } from '../modules/bookings/expiry';

/**
 * Local admin CLI (CONTRACTS §9.9): `npm run admin -- <command> [args]`.
 * Wraps the same AdminService the HTTP admin API uses.
 */
const HELP = `Usage: npm run admin -- <command> [args]

  partners [status]                       List partners (optionally by status)
  approve-partner <partnerId|ownerEmail>  Approve a partner
  reject-partner <partnerId> <reason…>    Reject a partner verification
  suspend-partner <partnerId> <reason…>   Suspend an approved partner
  vehicles [status]                       List vehicles (default: pending_review)
  approve-vehicle <vehicleId>             Publish a vehicle pending review
  reject-vehicle <vehicleId> <reason…>    Reject a vehicle pending review
  approve-doc <partner|vehicle|customer> <documentId>
  reject-doc <partner|vehicle|customer> <documentId> <reason…>
  generate-payouts <YYYY-MM-DD> <YYYY-MM-DD>
  mark-paid <payoutId> <reference>
  expire-bookings                         Run the hold/response expiry job now
  make-admin <email>                      Grant admin to an existing user
`;

async function main(): Promise<void> {
  process.env.ENABLE_CRON = 'false';
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const admin = app.get(AdminService);
  const db = app.get<Db>(KYSELY);
  const need = (n: number) => {
    if (args.length < n) throw new Error(`Missing arguments.\n\n${HELP}`);
  };
  const resolvePartner = async (idOrEmail: string): Promise<string> => {
    if (!idOrEmail.includes('@')) return idOrEmail;
    const row = await db
      .selectFrom('profiles as pr')
      .innerJoin('partner_members as pm', 'pm.user_id', 'pr.user_id')
      .select('pm.partner_id')
      .where('pr.email', '=', idOrEmail.toLowerCase())
      .executeTakeFirst();
    if (!row) throw new Error(`No partner found for ${idOrEmail}`);
    return row.partner_id;
  };
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  try {
    switch (cmd) {
      case 'partners': {
        const page = await admin.listPartners(
          Object.assign(new AdminPartnersQuery(), { status: args[0], page: 1, pageSize: 100 }),
        );
        console.table(
          page.items.map((p) => ({
            id: p.id,
            name: p.displayName,
            country: p.countryCode,
            status: p.status,
            owner: p.ownerEmail,
          })),
        );
        break;
      }
      case 'approve-partner':
        need(1);
        print(await admin.approvePartner(await resolvePartner(args[0])));
        break;
      case 'reject-partner':
        need(2);
        print(await admin.rejectPartner(await resolvePartner(args[0]), args.slice(1).join(' ')));
        break;
      case 'suspend-partner':
        need(2);
        print(await admin.suspendPartner(await resolvePartner(args[0]), args.slice(1).join(' ')));
        break;
      case 'vehicles': {
        const page = await admin.listVehicles(
          Object.assign(new AdminVehiclesQuery(), { status: args[0] ?? 'pending_review', page: 1, pageSize: 100 }),
        );
        console.table(
          page.items.map((v) => ({
            id: v.id,
            vehicle: `${v.make} ${v.model} ${v.year}`,
            partner: v.partner.displayName,
            status: v.status,
            images: v.imageCount,
            docs: v.documentCount,
          })),
        );
        break;
      }
      case 'approve-vehicle':
        need(1);
        print(await admin.approveVehicle(args[0]));
        break;
      case 'reject-vehicle':
        need(2);
        print(await admin.rejectVehicle(args[0], args.slice(1).join(' ')));
        break;
      case 'approve-doc':
      case 'reject-doc': {
        need(cmd === 'approve-doc' ? 2 : 3);
        const kind = args[0] as DocKind;
        if (!['partner', 'vehicle', 'customer'].includes(kind))
          throw new Error('kind must be partner, vehicle or customer');
        print(
          await admin.reviewDocument(
            kind,
            args[1],
            cmd === 'approve-doc' ? 'approve' : 'reject',
            args.slice(2).join(' ') || undefined,
          ),
        );
        break;
      }
      case 'generate-payouts':
        need(2);
        print(await admin.generatePayouts({ periodStart: args[0], periodEnd: args[1] }));
        break;
      case 'mark-paid':
        need(2);
        print(await admin.markPayoutPaid(args[0], args[1]));
        break;
      case 'expire-bookings':
        print({ expired: await app.get(ExpiryService).run() });
        break;
      case 'make-admin': {
        need(1);
        const res = await db
          .updateTable('profiles')
          .set({ is_admin: true })
          .where('email', '=', args[0].toLowerCase())
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0)
          throw new Error(`No profile for ${args[0]} (the user must have signed in once or been seeded).`);
        console.log(`${args[0]} is now an admin.`);
        break;
      }
      default:
        throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof AppException) console.error(`✗ ${err.code}: ${err.message}`);
  else console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
