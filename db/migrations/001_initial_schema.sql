CREATE TABLE inventory (
  inventory_code text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('Available', 'Available on Inquiry', 'Reserved', 'Sold')),
  original_quantity integer NOT NULL CHECK (original_quantity >= 0),
  reservation_type text CHECK (reservation_type IN ('manual_studio', 'checkout_hold')),
  reserved_until timestamptz,
  reserved_order_id text,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'Reserved' AND reservation_type IS NOT NULL AND reservation_type IN ('manual_studio', 'checkout_hold'))
    OR (status <> 'Reserved' AND reservation_type IS NULL AND reserved_until IS NULL AND reserved_order_id IS NULL)
  ),
  CHECK (
    reservation_type IS DISTINCT FROM 'checkout_hold'
    OR (reserved_until IS NOT NULL AND reserved_order_id IS NOT NULL)
  )
);

CREATE INDEX inventory_checkout_holds_expiry_idx
  ON inventory (reserved_until)
  WHERE reservation_type = 'checkout_hold';

CREATE TABLE orders (
  order_id text PRIMARY KEY,
  client_request_id text,
  order_type text NOT NULL,
  payment_status text NOT NULL CHECK (payment_status IN (
    'payment_pending', 'pending', 'demo_simulated', 'confirmed', 'failed', 'cancelled', 'expired'
  )),
  razorpay_order_id text,
  razorpay_payment_id text,
  order_data jsonb NOT NULL CHECK (jsonb_typeof(order_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX orders_client_request_id_unique
  ON orders (client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX orders_razorpay_order_id_unique
  ON orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;
CREATE UNIQUE INDEX orders_razorpay_payment_id_unique
  ON orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);

CREATE TABLE order_items (
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  item_index integer NOT NULL CHECK (item_index >= 0),
  inventory_code text NOT NULL REFERENCES inventory(inventory_code),
  purchase_type text NOT NULL CHECK (purchase_type IN ('original', 'commission', 'stocked')),
  quantity integer NOT NULL CHECK (quantity > 0),
  item_data jsonb NOT NULL CHECK (jsonb_typeof(item_data) = 'object'),
  PRIMARY KEY (order_id, item_index)
);
CREATE INDEX order_items_inventory_code_idx ON order_items (inventory_code);

CREATE TABLE payment_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  order_id text REFERENCES orders(order_id),
  razorpay_payment_id text,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_order_id_idx ON payment_events (order_id);
