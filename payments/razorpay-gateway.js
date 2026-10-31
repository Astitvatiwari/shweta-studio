const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

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

export function getRazorpayFailureLogFields(error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 'none';
  const category = /^[a-z_]+$/.test(error?.gatewayCategory || '') ? error.gatewayCategory : 'unexpected';
  const code = /^[A-Z0-9_]+$/.test(error?.gatewayErrorCode || '') ? error.gatewayErrorCode : 'none';
  return `category=${category} status=${status} code=${code}`;
}
