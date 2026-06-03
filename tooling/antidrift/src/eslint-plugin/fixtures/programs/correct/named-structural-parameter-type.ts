type UserLookup = { id: string; email: string };

function sendEmail(user: UserLookup) {
  return user.email;
}

void sendEmail;
