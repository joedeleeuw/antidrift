export function UserList() {
  fetch("/api/users");
  return <div>Users</div>;
}
