import { AppError, uuidSchema } from '@laqum/shared';
import { Router, raw } from 'express';
import type { AppContext } from '../context.js';
import { handle } from '../middleware/validate.js';
import { confirmPayment, type PaymentsContext } from './service.js';
import { SIGNATURE_HEADER, WEAK_SIGNATURE_HEADER, verifyWebhookSignature } from './signature.js';

/**
 * The Chapa webhook.
 *
 * Three rules, in order:
 *   1. verify the signature over the RAW bytes, before anything is parsed;
 *   2. answer fast — the only work done inline is reading tx_ref;
 *   3. never act on the body. tx_ref is a LOOKUP KEY; the decision comes from
 *      calling verify() and reading that.
 *
 * Idempotency is the database's: the payments row status, the
 * one_paid_*_per_booking partial unique indexes, and transition()'s
 * compare-and-set. A duplicate delivery therefore costs one verify call and
 * changes nothing.
 */

interface WebhookBody {
  tx_ref?: unknown;
  trx_ref?: unknown;
  reference?: unknown;
}

/** Chapa has used tx_ref and trx_ref in different places; accept either. */
export function referenceFromWebhook(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as WebhookBody;
  for (const value of [candidate.tx_ref, candidate.trx_ref, candidate.reference]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function webhookRouter(ctx: PaymentsContext): Router {
  const router = Router();

  router.post(
    '/chapa',
    // Raw, not json: the signature covers the exact bytes Chapa sent.
    raw({ type: '*/*', limit: '256kb' }),
    handle(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const signature = req.get(SIGNATURE_HEADER);

      const check = verifyWebhookSignature(ctx.config.CHAPA_WEBHOOK_SECRET, rawBody, signature);
      if (!check.ok) {
        ctx.logger.warn(
          {
            reason: check.reason,
            // Logged so a "why is my webhook rejected" can be answered without
            // guessing: Chapa's weaker header is deliberately not accepted.
            sawWeakHeaderOnly:
              signature === undefined && req.get(WEAK_SIGNATURE_HEADER) !== undefined,
          },
          'rejected Chapa webhook',
        );
        res.status(401).json({
          error: { code: 'UNAUTHENTICATED', message: 'Invalid webhook signature' },
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        // Signed by us but unreadable. Acknowledge so Chapa stops retrying,
        // and log it: retrying will not make it parse.
        ctx.logger.error('Chapa webhook passed signature check but is not JSON');
        res.status(200).json({ received: true });
        return;
      }

      const txRef = referenceFromWebhook(parsed);
      if (txRef === null) {
        ctx.logger.error({ parsed }, 'Chapa webhook carried no transaction reference');
        res.status(200).json({ received: true });
        return;
      }

      // Acknowledge first, process after. Chapa gets a fast 200 and never
      // retries because we were slow; the work is retried by the queue, not by
      // the sender.
      res.status(200).json({ received: true });

      try {
        const outcome = await confirmPayment(ctx, txRef);
        ctx.logger.info({ txRef, outcome: outcome.kind }, 'processed Chapa webhook');
      } catch (err) {
        ctx.logger.error({ err, txRef }, 'failed to process Chapa webhook');
      }
    }),
  );

  return router;
}

/** POST /v1/admin/payments/:id/refund-recorded and GET /v1/admin/refunds live here. */
export function assertUuid(value: unknown, what: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', `${what} must be a uuid`);
  return parsed.data;
}

export type { AppContext };
