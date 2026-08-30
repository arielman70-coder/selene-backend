import type { Request, Response } from 'express';
import { handleCheckoutUpsert } from './checkout-create';

export function handleCheckoutUpdate(req: Request, res: Response): Promise<void> {
  return handleCheckoutUpsert(req, res, 'checkouts/update');
}
