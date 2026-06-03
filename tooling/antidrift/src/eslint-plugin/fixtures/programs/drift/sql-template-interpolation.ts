function loadUser(id: string) {
  return `SELECT * FROM users WHERE id = ${id}`;
}

void loadUser;
