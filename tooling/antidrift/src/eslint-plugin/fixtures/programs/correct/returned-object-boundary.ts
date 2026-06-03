type PaymentAuditContext = {
  requestId: string;
};

export function createPaymentGateway(_context: PaymentAuditContext) {
  const loadAuditEvents = (): Promise<string[]> => Promise.resolve([]);

  function flushAuditEvents(): Promise<void> {
    return Promise.resolve();
  }

  return {
    flushAuditEvents,
    loadAuditEvents,
    recordAuditEvent(_eventName: string): Promise<void> {
      return Promise.resolve();
    },
  };
}
