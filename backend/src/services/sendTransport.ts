import { createAccountSmtpTransport } from './smtpTransport.js';

/**
 * The one place a send is bound to a transport.
 *
 * The route used to reach `createAccountSmtpTransport` directly, which made "how mail
 * leaves this installation" an SMTP question by construction. It is not one: a Microsoft
 * Graph account sends over Graph, and v4 Stage 3 is where that lands. Binding the route
 * to this seam instead means the Graph adapter becomes a branch **here** rather than a
 * second pipeline inside a 1067-line route.
 *
 * Nothing else about the send path moves. The `delivered` flag, the intent claim and the
 * uncertain-outcome handling stay where they are, which is what makes this a wrap: the
 * boundary that decides whether an outcome is knowable is already correct, and the
 * transport only has to be pluggable *behind* it.
 *
 * A Microsoft Graph account is still refused, and deliberately by the SMTP factory
 * rather than by a second copy of the same check here: one guard, in the place that
 * would otherwise hand a native account to nodemailer. When the Graph transport exists
 * that guard becomes unreachable for this path and the branch below takes over.
 */
export async function createAccountMailTransport<Account extends Parameters<typeof createAccountSmtpTransport>[0]>(
  account: Account,
) {
  // The Graph branch belongs exactly here. It is not written yet, and it is not stubbed
  // with a second refusal, because two guards for one condition drift. The account type
  // is carried through rather than widened, so the route keeps the row it passed in.
  return createAccountSmtpTransport(account);
}
