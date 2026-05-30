export type PaymentAuditContext = {
  requestId: string;
  userId: string;
};

export function createPaymentGateway(_context: PaymentAuditContext) {
  return {
    recordAuditEvent(_eventName: string): Promise<void> {
      // Template placeholder: log _context.requestId, _context.userId, _eventName to audit trail.
      return Promise.resolve();
    },
  };
}
