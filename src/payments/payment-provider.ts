export interface Money {
  amountMinor: number;
  currency: string;
}

export type IntentStatus = 'requires_confirmation' | 'authorized' | 'captured' | 'failed' | 'voided';

export interface CreatedIntent {
  intentId: string;
  clientSecret: string;
  status: IntentStatus;
}

export interface ConfirmResult {
  status: 'authorized' | 'failed';
  failureReason?: string;
}

export interface ProviderResult {
  ok: boolean;
  reference: string;
  failureReason?: string;
}

/** CONTRACTS §8. Only the backend talks to the provider; clients never see secrets. */
export interface PaymentProvider {
  readonly name: string;
  createIntent(input: { bookingId: string; amount: Money }): Promise<CreatedIntent>;
  /** Verifies and authorizes an intent. `simulateOutcome` is honoured only by the mock. */
  confirm(input: { intentId: string; amount: Money; simulateOutcome?: 'success' | 'fail' }): Promise<ConfirmResult>;
  capture(input: { intentId: string; amount: Money }): Promise<ProviderResult>;
  void(input: { intentId: string }): Promise<ProviderResult>;
  refund(input: { intentId: string; amount: Money }): Promise<ProviderResult>;
  holdDeposit(input: { bookingId: string; amount: Money }): Promise<ProviderResult>;
  releaseDeposit(input: { holdReference: string; amount: Money }): Promise<ProviderResult>;
  verifyWebhook(input: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): Promise<boolean>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
