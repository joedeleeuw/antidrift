async function notifyUsers(ids: string[]) {
  ids.forEach(async (id) => {
    await fetch(`/users/${id}/notify`);
  });
}

void notifyUsers;
