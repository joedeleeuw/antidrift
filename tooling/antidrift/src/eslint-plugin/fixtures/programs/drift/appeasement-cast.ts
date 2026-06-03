type UserDto = {
  id: string;
  email: string;
};

declare const raw: unknown;
declare const parsedJson: any;

export const fromUnknown = raw as UserDto;
export const fromAny = parsedJson as UserDto;
