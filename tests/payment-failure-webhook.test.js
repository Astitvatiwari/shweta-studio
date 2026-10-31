import assert from 'node:assert/strict';
import { recordPaymentFailure } from '../payments/payment-failure-webhook.js';

let updateArgs;
const recorded = await recordPaymentFailure({
  updateOrderPaymentStatus: async (...args) => {
    updateArgs = args;
    return { success: true };
  },
  orderId: 'ORD-synthetic-1',
  razorpayPaymentId: 'pay_synthetic_1',
  eventId: 'evt_synthetic_1'
});
assert.deepEqual(updateArgs, ['ORD-synthetic-1', {
  paymentStatus: 'failed',
  razorpayPaymentId: 'pay_synthetic_1',
  eventId: 'evt_synthetic_1',
  eventType: 'payment.failed'
}]);
assert.equal(recorded.statusCode, 200);
assert.equal(recorded.body.success, true);

const rejected = await recordPaymentFailure({
  updateOrderPaymentStatus: async () => ({
    success: false,
    statusCode: 400,
    error: 'Internal payment transition detail'
  }),
  orderId: 'ORD-synthetic-2',
  razorpayPaymentId: 'pay_synthetic_2',
  eventId: 'evt_synthetic_2'
});
assert.equal(rejected.statusCode, 503, 'a rejected database transition asks Razorpay to retry delivery');
assert.equal(rejected.body.success, false, 'a rejected transition is never reported as recorded');
assert.match(rejected.body.error, /retried/i);
assert.doesNotMatch(JSON.stringify(rejected.body), /Internal payment transition detail/);

await assert.rejects(recordPaymentFailure({
  updateOrderPaymentStatus: async () => { throw new Error('database unavailable'); },
  orderId: 'ORD-synthetic-3',
  razorpayPaymentId: 'pay_synthetic_3',
  eventId: 'evt_synthetic_3'
}), /database unavailable/);

console.log('Payment failure webhook handling checks passed.');
