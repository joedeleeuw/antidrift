export const buttonClassNames = {
  primary: "rounded-md bg-surface-primary px-3 py-2 text-fg-on-primary shadow-sm ring-focus",
  secondary: "rounded-md border-border-subtle bg-surface-default px-3 py-2 text-fg-default shadow-sm ring-focus",
} as const;

export type ButtonVariant = keyof typeof buttonClassNames;
