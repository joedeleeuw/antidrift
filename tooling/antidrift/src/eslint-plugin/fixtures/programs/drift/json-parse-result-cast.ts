type UserDto = {
  id: string;
  email: string;
};

declare const payload: string;

export const user = JSON.parse(payload) as UserDto;
