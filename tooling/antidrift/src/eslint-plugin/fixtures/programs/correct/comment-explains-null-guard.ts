function normalizeEmail(email: string | null) {
  // External identity providers may omit email for phone-only accounts.
  if (email === null) return "unknown@example.com";
  return email.toLowerCase();
}

void normalizeEmail;
