export async function recordPaymentFailure({ updateOrderPaymentStatus, orderId, razorpayPaymentId, eventId }) {
  const result = await updateOrderPaymentStatus(orderId, {
    paymentStatus: 'failed',
    razorpayPaymentId,
    eventId,
    eventType: 'payment.failed'
  });

  if (!result?.success) {
    return {
      statusCode: 503,
      body: {
        success: false,
        error: 'Payment failure could not be recorded. Webhook delivery should be retried.'
      }
    };
  }

  return {
    statusCode: 200,
    body: { success: true, message: 'Payment failure recorded and hold released.' }
  };
}
