import type { ButtonHTMLAttributes, ReactNode } from "react";

import { buttonClassNames, type ButtonVariant } from "./tokens";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
};

export function Button({ children, variant = "primary", ...props }: ButtonProps) {
  return (
    <button className={buttonClassNames[variant]} type="button" {...props}>
      {children}
    </button>
  );
}
