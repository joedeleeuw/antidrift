type UserDto = {
  id: string;
  email: string;
};

declare const raw: unknown;

function isUserDto(value: unknown): value is UserDto {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && "email" in value;
}

export function loadUser(): UserDto {
  if (isUserDto(raw)) return raw;
  throw new Error("Invalid user.");
}
