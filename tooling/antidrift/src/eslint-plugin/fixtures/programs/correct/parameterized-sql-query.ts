declare const db: { query(sql: string, values: readonly unknown[]): Promise<unknown> };

function loadUser(id: string) {
  return db.query("SELECT * FROM users WHERE id = $1", [id]);
}

void loadUser;
