import { Router } from 'express';
import { verifyShopifyWebhook } from './middleware';
import { handleCheckoutCreate } from './checkout-create';
import { handleCheckoutUpdate } from './checkout-update';
import { handleOrderCreate } from './order-create';
import { handleOrderPaid } from './order-paid';
import { handleOrderRefund } from './order-refund';

export const webhookRouter = Router();

// HMAC first — nothing below runs on an unverified payload.
webhookRouter.use(verifyShopifyWebhook);

webhookRouter.post('/checkout-create', handleCheckoutCreate);
webhookRouter.post('/checkout-update', handleCheckoutUpdate);
webhookRouter.post('/order-create', handleOrderCreate);
webhookRouter.post('/order-paid', handleOrderPaid);
webhookRouter.post('/order-refund', handleOrderRefund);
