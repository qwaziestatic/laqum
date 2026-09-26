import type { Clock } from '@laqum/shared';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { ChapaProvider } from './chapa.js';
import { DEV_CHECKOUT_PATH } from './devCheckout.js';
import { FakePaymentProvider } from './fake.js';
import type { PaymentProvider } from './provider.js';

/**
 * The payment provider this process uses, from its configuration.
 *
 * The fake one sends drivers to the development checkout page on this API
 * (PUBLIC_BASE_URL, which on a phone must be the machine's LAN address), and
 * reports a payment's outcome only once Pay or Fail is pressed there, unless
 * FAKE_PAYMENT_DELAY_SECONDS asks for the old automatic success.
 */
export function paymentProviderFor(
  config: Config,
  deps: { clock: Clock; logger: Logger },
): PaymentProvider {
  if (config.PAYMENT_PROVIDER === 'chapa') {
    return new ChapaProvider({
      // Validated as present when PAYMENT_PROVIDER is chapa.
      secretKey: config.CHAPA_SECRET_KEY ?? '',
      baseUrl: config.CHAPA_BASE_URL,
      logger: deps.logger,
    });
  }
  return new FakePaymentProvider({
    clock: deps.clock,
    autoSucceedAfterSeconds: config.FAKE_PAYMENT_DELAY_SECONDS ?? null,
    baseCheckoutUrl: `${config.PUBLIC_BASE_URL.replace(/\/+$/u, '')}${DEV_CHECKOUT_PATH}`,
  });
}
