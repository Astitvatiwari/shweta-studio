const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';
const RAZORPAY_PAYMENTS_URL = 'https://api.razorpay.com/v1/payments';

function networkFailure(error) {
  let current = error;
  let code = null;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    if (typeof current.code === 'string') {
      code = current.code;
      break;
    }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { category: 'dns', code };
  if (typeof code === 'string' && (/^ERR_TLS_/.test(code) || /^ERR_SSL_/.test(code) ||
      /^CERT_/.test(code) || /CERT|SSL|TLS|SIGNATURE/.test(code))) {
    return { category: 'tls', code };
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return { category: 'timeout', code };
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return { category: 'connection', code };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { category: 'timeout', code };
  }
  return { category: 'request', code: null };
}

function gatewayEndpoint() {
  const configured = process.env.RAZORPAY_API_URL || RAZORPAY_ORDERS_URL;
  let url;
  try {
    url = new URL(configured);
  } catch {
    const error = new Error('Razorpay endpoint configuration is invalid.');
    error.gatewayCategory = 'endpoint_configuration';
    throw error;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.razorpay.com' ||
      url.pathname !== '/v1/orders' || url.username || url.password || url.search || url.hash) {
    const error = new Error('Razorpay endpoint configuration is invalid.');
    error.gatewayCategory = 'endpoint_configuration';
    throw error;
  }
  return url.toString();
}

/** Create an official Razorpay order without exposing credentials or response bodies. */
export async function createRazorpayGatewayOrder({ amountPaise, currency, receipt, notes }) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured.');
    error.gatewayCategory = 'credentials';
    throw error;
  }
  const endpoint = gatewayEndpoint();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: currency.toUpperCase(),
        receipt: String(receipt).substring(0, 40),
        notes: notes || {}
      })
    });
  } catch (cause) {
    const details = networkFailure(cause);
    const error = new Error('Razorpay order request failed.');
    error.gatewayCategory = details.category;
    error.gatewayErrorCode = details.code;
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error('Razorpay returned an unreadable response.');
    error.gatewayCategory = 'invalid_response';
    error.statusCode = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('Razorpay rejected the order request.');
    error.gatewayCategory = 'http_response';
    error.statusCode = response.status;
    throw error;
  }
  if (!data || typeof data.id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(data.id)) {
    const error = new Error('Razorpay returned an invalid order response.');
    error.gatewayCategory = 'invalid_response';
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

/** Retrieve a payment from Razorpay using server-only credentials. */
export async function fetchRazorpayPayment(paymentId) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured.');
    error.gatewayCategory = 'credentials';
    throw error;
  }
  if (typeof paymentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(paymentId)) {
    const error = new Error('Razorpay payment identifier is invalid.');
    error.gatewayCategory = 'invalid_payment_id';
    throw error;
  }

  let response;
  try {
    response = await fetch(`${RAZORPAY_PAYMENTS_URL}/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
  } catch (cause) {
    const details = networkFailure(cause);
    const error = new Error('Razorpay payment lookup failed.');
    error.gatewayCategory = details.category;
    error.gatewayErrorCode = details.code;
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error('Razorpay returned an unreadable payment response.');
    error.gatewayCategory = 'invalid_response';
    error.statusCode = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error('Razorpay rejected the payment lookup.');
    error.gatewayCategory = 'provider_http';
    error.statusCode = response.status;
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== paymentId) {
    const error = new Error('Razorpay returned an invalid payment response.');
    error.gatewayCategory = 'invalid_response';
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

/**
 * Verify that a provider payment is a captured payment for this exact local
 * checkout. Both the browser callback and webhook must use the same rules.
 */
export async function verifyRazorpayCapturedPayment({ order, paymentId, razorpayOrderId }) {
  if (!order || typeof order.orderId !== 'string' || !order.orderId ||
      typeof order.razorpayOrderId !== 'string' || !order.razorpayOrderId ||
      order.razorpayOrderId !== razorpayOrderId) {
    return { verified: false, reason: 'order_mismatch' };
  }

  const legacyAmount = Number.parseFloat(String(order.total || order.subtotal || '').replace(/[^0-9.]/g, ''));
  const amount = order.subtotalNumeric == null ? legacyAmount : Number(order.subtotalNumeric);
  const expectedAmountPaise = Math.round(amount * 100);
  const currency = typeof order.currency === 'string' && order.currency
    ? order.currency.toUpperCase() : 'INR';
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(expectedAmountPaise) ||
      !/^[A-Z]{3}$/.test(currency)) {
    return { verified: false, reason: 'local_order_invalid' };
  }

  const payment = await fetchRazorpayPayment(paymentId);
  if (payment.id !== paymentId || payment.order_id !== order.razorpayOrderId ||
      (payment.notes?.orderId && payment.notes.orderId !== order.orderId)) {
    return { verified: false, reason: 'payment_mismatch' };
  }
  if (!Number.isSafeInteger(payment.amount) || payment.amount !== expectedAmountPaise) {
    return { verified: false, reason: 'amount_mismatch' };
  }
  if (typeof payment.currency !== 'string' || payment.currency.toUpperCase() !== currency) {
    return { verified: false, reason: 'currency_mismatch' };
  }
  if (payment.status !== 'captured') {
    return { verified: false, reason: 'not_captured' };
  }

  return { verified: true, payment };
}

export function getRazorpayFailureLogFields(error, stage = 'gateway_create') {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 'none';
  const allowedStage = ['gateway_create', 'persist_order_id', 'recover_order_id'].includes(stage) ? stage : 'unknown';
  let category = /^[a-z_]+$/.test(error?.gatewayCategory || '') ? error.gatewayCategory : 'unexpected';
  let code = /^[A-Z0-9_]+$/.test(error?.gatewayErrorCode || '') ? error.gatewayErrorCode : 'none';
  if (allowedStage === 'persist_order_id' || allowedStage === 'recover_order_id') {
    category = 'database_persistence';
    code = /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : 'none';
  }
  return `stage=${allowedStage} category=${category} status=${status} code=${code}`;
}

export async function resolveRazorpayOrderFailure({ gatewayOrderReceived, latestOrder, releaseReservation }) {
  if (latestOrder?.razorpayOrderId) return { action: 'reuse_persisted_order', order: latestOrder };
  if (gatewayOrderReceived) return { action: 'retain_reservation' };
  const released = await releaseReservation();
  return { action: released?.success ? 'reservation_released' : 'release_unconfirmed' };
}
