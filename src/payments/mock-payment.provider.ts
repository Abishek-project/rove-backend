import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import type { ConfirmResult, CreatedIntent, Money, PaymentProvider, ProviderResult } from './payment-provider';

const INTENT_ID = /^pi_mock_[0-9a-f]{32}$/;

/**
 * Deterministic in-process mock (PAYMENT_PROVIDER=mock). Never moves real money.
 * The database `payments` table is the source of truth for intent state.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  createIntent(input: { bookingId: string; amount: Money }): Promise<CreatedIntent> {
    void input;
    const intentId = `pi_mock_${randomUUID().replace(/-/g, '')}`;
    return Promise.resolve({
      intentId,
      clientSecret: `${intentId}_secret_${randomBytes(12).toString('hex')}`,
      status: 'requires_confirmation',
    });
  }

  confirm(input: { intentId: string; amount: Money; simulateOutcome?: 'success' | 'fail' }): Promise<ConfirmResult> {
    if (!INTENT_ID.test(input.intentId)) {
      return Promise.resolve({
        status: 'failed',
        failureReason: 'unknown_intent',
      });
    }
    if (input.simulateOutcome === 'fail') {
      return Promise.resolve({
        status: 'failed',
        failureReason: 'card_declined',
      });
    }
    return Promise.resolve({ status: 'authorized' });
  }

  capture(input: { intentId: string; amount: Money }): Promise<ProviderResult> {
    return Promise.resolve({ ok: true, reference: input.intentId });
  }

  void(input: { intentId: string }): Promise<ProviderResult> {
    return Promise.resolve({ ok: true, reference: input.intentId });
  }

  refund(input: { intentId: string; amount: Money }): Promise<ProviderResult> {
    void input;
    return Promise.resolve({
      ok: true,
      reference: `re_mock_${randomUUID().replace(/-/g, '')}`,
    });
  }

  holdDeposit(input: { bookingId: string; amount: Money }): Promise<ProviderResult> {
    void input;
    return Promise.resolve({
      ok: true,
      reference: `dh_mock_${randomUUID().replace(/-/g, '')}`,
    });
  }

  releaseDeposit(input: { holdReference: string; amount: Money }): Promise<ProviderResult> {
    return Promise.resolve({
      ok: true,
      reference: `${input.holdReference}_rel`,
    });
  }

  verifyWebhook(): Promise<boolean> {
    // The mock has no webhooks; a real provider verifies the signature here.
    return Promise.resolve(false);
  }
}
